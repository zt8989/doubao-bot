// Gitea 创建合并请求——复用浏览器登录态，重放 compare 页新建表单 AJAX（无需 API token）。
// 表单与新建工单同构（form#new-issue：title/content + 侧栏 combo-value 隐藏域）；
// 已有同分支 PR 时页面不渲染表单，改为"查看合并请求"链接；无差异时提示"没有差异可显示"。
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
const WIP_RE = /^(WIP:|WIP\)|\[WIP\])/i;

cli({
  site: 'gitea',
  name: 'pr',
  description: '在 Gitea 仓库创建合并请求（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'base', type: 'string', required: true, help: '目标分支（合并到）' },
    { name: 'head', type: 'string', required: true, help: '来源分支（变更来自）' },
    { name: 'title', type: 'string', required: true, help: '合并请求标题' },
    { name: 'body', type: 'string', default: '', help: '描述（Markdown）' },
    { name: 'image', type: 'string', default: '', help: '附件图片，本地路径，逗号分隔多个；上传后随创建提交' },
    { name: 'assignee', type: 'string', default: '', help: '指派人，用户名或 id，逗号分隔多个' },
    { name: 'milestone', type: 'string', default: '', help: '里程碑，名称或 id' },
    { name: 'label', type: 'string', default: '', help: '标签，名称或 id，逗号分隔多个' },
    { name: 'project', type: 'string', default: '', help: '项目，名称或 id' },
    { name: 'reviewer', type: 'string', default: '', help: '评审人，用户名或 id，逗号分隔多个' },
    { name: 'draft', type: 'bool', default: false, help: '创建为草稿（标题自动加 WIP: 前缀）' },
  ],
  columns: ['prNumber', 'title', 'base', 'head', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const base = String(args.base ?? '').trim();
    const head = String(args.head ?? '').trim();
    if (!base) throw new ArgumentError('base 不能为空');
    if (!head) throw new ArgumentError('head 不能为空');
    if (base === head) throw new ArgumentError(`base 和 head 不能相同: "${base}"`);
    let title = String(args.title ?? '').trim();
    if (!title) throw new ArgumentError('title 不能为空');
    const draft = Boolean(args.draft);
    if (draft && !WIP_RE.test(title)) title = `WIP: ${title}`;
    let body = String(args.body ?? '');
    const splitList = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const extra = {
      assignees: splitList(args.assignee),
      milestone: String(args.milestone ?? '').trim(),
      labels: splitList(args.label),
      project: String(args.project ?? '').trim(),
      reviewers: splitList(args.reviewer),
    };

    const imageFiles = [];
    for (const raw of splitList(args.image)) {
      const p = raw.replace(/^~(?=\/|$)/, homedir());
      let buf;
      try {
        buf = await readFile(p);
      } catch {
        throw new ArgumentError(`图片不存在或不可读: ${raw}`);
      }
      imageFiles.push({ name: basename(p), mime: MIME[extname(p).toLowerCase()] || 'application/octet-stream', b64: buf.toString('base64') });
    }

    const compareUrl = `${BASE}/${repo}/compare/${base}...${head}`;
    try {
      await page.goto(compareUrl, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开 ${compareUrl} 失败: ${error?.message || error}`);
    }

    const state = await page.evaluate(() => ({
      url: window.location.href,
      hasForm: !!document.querySelector('#new-issue'),
      existingPr: document.querySelector('a[href*="/pulls/"]')?.getAttribute('href') || null,
      noDiff: /没有差异|nothing to compare/i.test(document.body.textContent || ''),
      bodySnippet: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150),
    }));
    if (/\/user\/login/.test(state.url)) {
      throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    }
    if (!state.hasForm) {
      if (state.existingPr) {
        throw new CommandExecutionError(
          `${base} ← ${head} 已存在合并请求: ${BASE}${state.existingPr}，不能重复创建`,
        );
      }
      if (state.noDiff) {
        throw new CommandExecutionError(`${base} 与 ${head} 之间没有差异，无需创建合并请求`);
      }
      throw new CommandExecutionError(
        `compare 页没有创建表单，请确认分支 ${base}、${head} 存在。页面提示: ${state.bodySnippet}`,
      );
    }

    const removeUploads = async (list) => {
      if (!list.length) return;
      try {
        await page.evaluate(async ({ removeUrl, uuids }) => {
          for (const u of uuids) {
            const fd = new FormData();
            fd.append('file', u);
            await fetch(removeUrl, { method: 'POST', body: fd, credentials: 'include' });
          }
        }, { removeUrl: `${BASE}/${repo}/issues/attachments/remove`, uuids: list });
      } catch {
        // 清理失败不影响主流程
      }
    };

    // 附件上传与工单同款：dropzone data-upload-url 返回 {uuid}，uuid 以 files 字段随表单提交
    let uuids = [];
    if (imageFiles.length) {
      const uploaded = await page.evaluate(async (files) => {
        const uploadUrl = document.querySelector('.dropzone[data-upload-url]')?.getAttribute('data-upload-url');
        if (!uploadUrl) return { error: 'NO_UPLOAD_URL' };
        const uuids = [];
        for (const f of files) {
          const bin = atob(f.b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const fd = new FormData();
          fd.append('file', new File([bytes], f.name, { type: f.mime }));
          const resp = await fetch(uploadUrl, { method: 'POST', body: fd, credentials: 'include' });
          const ct = resp.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
          if (!data?.uuid) return { error: 'UPLOAD_FAILED', name: f.name, status: resp.status, uuids };
          uuids.push(data.uuid);
        }
        return { uuids };
      }, imageFiles);
      if (uploaded.error === 'NO_UPLOAD_URL') {
        throw new CommandExecutionError('compare 页未找到附件上传端点（dropzone data-upload-url）');
      }
      if (uploaded.error) {
        await removeUploads(uploaded.uuids || []);
        throw new CommandExecutionError(`图片 ${uploaded.name} 上传失败: HTTP ${uploaded.status}，请确认文件类型与实例附件限制`);
      }
      uuids = uploaded.uuids;
      const imgMarkdown = uuids.map((u, i) => `![${imageFiles[i].name}](/attachments/${u})`).join('\n');
      if (imgMarkdown) body = body ? `${body}\n\n${imgMarkdown}` : imgMarkdown;
    }

    const result = await page.evaluate(async ({ title, body, extra, uuids }) => {
      const form = document.querySelector('#new-issue');
      const titleInput = form.querySelector('input[name=title]');
      if (!titleInput) return { error: 'NO_TITLE' };
      const setNativeValue = (el, proto, value) => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setNativeValue(titleInput, HTMLInputElement.prototype, title);
      if (body) {
        const content = form.querySelector('textarea[name=content]');
        if (content) setNativeValue(content, HTMLTextAreaElement.prototype, body);
      }

      // 侧栏 combo（指派/里程碑/标签/项目/评审人）选项解析：名称或 id -> data-value，写入 combo-value
      const applyCombo = (inputName, wanted) => {
        if (!wanted.length) return null;
        const combo = [...form.querySelectorAll('.issue-sidebar-combo')]
          .find((c) => c.querySelector('.combo-value')?.name === inputName);
        if (!combo) return `表单中未找到 ${inputName} 字段`;
        const items = [...combo.querySelectorAll('.ui.dropdown .menu > .item[data-value]')].map((el) => ({
          id: el.getAttribute('data-value'),
          name: el.querySelector('img')?.getAttribute('title') || el.textContent.trim(),
        }));
        const ids = [];
        for (const w of wanted) {
          const it = items.find((i) => i.name === w || i.id === w);
          if (!it) {
            return `字段 ${inputName} 找不到选项 "${w}"，可用: ${items.map((i) => i.name).join(', ') || '（仓库无可选项）'}`;
          }
          ids.push(it.id);
        }
        combo.querySelector('.combo-value').value = ids.join(',');
        return null;
      };

      const comboError =
        applyCombo('assignee_ids', extra.assignees) ??
        applyCombo('reviewer_ids', extra.reviewers) ??
        applyCombo('milestone_id', extra.milestone ? [extra.milestone] : []) ??
        applyCombo('label_ids', extra.labels) ??
        applyCombo('project_ids', extra.project ? [extra.project] : []);
      if (comboError) return { error: 'ARGUMENT', message: comboError };

      const formData = new FormData(form);
      for (const u of uuids) formData.append('files', u);
      const resp = await fetch(form.action, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        headers: { 'x-gitea-fetch-action': '1' },
      });
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { error: 'NOT_JSON', status: resp.status };
      }
      const data = await resp.json();
      return { status: resp.status, redirect: data.redirect || null, errorMessage: data.errorMessage || null };
    }, { title, body, extra, uuids });

    const abortWith = async (error) => {
      await removeUploads(uuids);
      throw error;
    };
    if (result.error === 'ARGUMENT') {
      await abortWith(new ArgumentError(result.message));
    }
    if (result.error === 'NO_TITLE' || result.status === 401 || result.status === 403) {
      await abortWith(new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`));
    }
    if (!result.redirect) {
      await abortWith(new CommandExecutionError(
        `创建合并请求失败: HTTP ${result.status}${result.errorMessage ? `（${result.errorMessage}）` : result.error ? ` (${result.error})` : ''}，请确认登录态是否有效`,
      ));
    }

    return {
      prNumber: Number(/(\d+)$/.exec(result.redirect)?.[1]),
      title,
      base,
      head,
      draft,
      url: `${BASE}${result.redirect}`,
    };
  },
});
