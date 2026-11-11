// Gitea 编辑合并请求标题/正文——复用浏览器登录态（无需 API token）。
// PR 复用工单编辑端点（编号与工单同序）：标题 POST /issues/{n}/title {title}，返回 {title}；
// 正文 POST /issues/{n}/content {content, context, content_version}，content_version 是乐观锁，
// 静态页面读不到，需点评论菜单"编辑"水合编辑器后从 data-content-version 读取；
// 版本过期返回 400（内容已被他人更改）。正文正文可 --append 追加（用于补 Closes #N 关联工单）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { bodyEquivalent, bodyDiff } from './utils.js';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'pr-edit',
  description: '编辑 Gitea 合并请求标题/正文（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'pr', type: 'int', required: true, positional: true, help: '合并请求编号，如 1' },
    { name: 'title', type: 'string', default: '', help: '新标题，省略则不修改' },
    { name: 'body', type: 'string', default: '', help: '新正文（Markdown），省略则不修改' },
    { name: 'append', type: 'bool', default: false, help: '把 body 追加到现有正文末尾（如补 Closes #N 关联工单）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['prNumber', 'title', 'bodyChanged', 'changed', 'contentVersion', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const pr = Number(args.pr);
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new ArgumentError(`pr 必须是正整数，当前: "${args.pr}"`);
    }
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '');
    const append = Boolean(args.append);
    if (!title && !body) throw new ArgumentError('title 和 body 至少提供一个');
    if (append && !body) throw new ArgumentError('append 模式需要提供 body（要追加的内容）');
    const prUrl = `${BASE}/${repo}/pulls/${pr}`;

    const openPrPage = async (tag) => {
      try {
        await page.goto(`${prUrl}?_=${Date.now()}-${tag}`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开合并请求页失败: ${error?.message || error}`);
      }
      const state = await page.evaluate(() => ({
        url: window.location.href,
        stateLabel: document.querySelector('.issue-state-label')?.textContent.trim() || null,
        hasComment: !!document.querySelector('.issue-content-comment'),
      }));
      if (/\/user\/login/.test(state.url)) {
        throw new CommandExecutionError(`无法访问合并请求 ${repo}#${pr}：请确认登录态有效`);
      }
      if (!state.hasComment) {
        throw new CommandExecutionError(`合并请求 ${repo}#${pr} 页面没有正文评论：请确认编号存在且有权限`);
      }
      return state;
    };

    // 点评论菜单"编辑"水合编辑器：读取正文原文（追加用）与乐观锁版本号
    const readEditor = () =>
      page.evaluate(() => {
        const comment = document.querySelector('.issue-content-comment');
        const editItem = [...comment.querySelectorAll('.menu > .item')].find((it) => it.textContent.trim() === '编辑');
        if (!editItem) return { error: 'NO_EDIT_ITEM' };
        editItem.click();
        return { clicked: true };
      });

    const readEditorState = () =>
      page.evaluate(() => {
        const comment = document.querySelector('.issue-content-comment');
        const textarea = comment.querySelector('textarea[name=content]');
        const versionEl = comment.querySelector('[data-content-version]');
        return {
          version: versionEl?.getAttribute('data-content-version') ?? null,
          content: textarea?.value ?? null,
        };
      });

    const waitEditor = async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const s = await readEditorState();
        if (s.version !== null && s.version !== 'undefined' && s.content !== null) return s;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new CommandExecutionError('编辑器未水合，读不到 content_version，请刷新后重试');
    };

    const maxAttempts = 3;
    // 跨轮状态：某轮真的写成功过，就不许再因为"下一轮发现无差异"把结果判成失败
    let wroteTitle = false;
    let wroteBody = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await openPrPage(attempt);

      if (title) {
        const titleResult = await page.evaluate(async ({ repo, pr, title }) => {
          const resp = await fetch(`/${repo}/issues/${pr}/title`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-gitea-fetch-action': '1' },
            body: new URLSearchParams({ title }),
          });
          const ct = resp.headers.get('content-type') || '';
          if (!ct.includes('application/json')) return { error: 'NOT_JSON', status: resp.status };
          const data = await resp.json();
          return { status: resp.status, title: data.title || null, errorMessage: data.errorMessage || null };
        }, { repo, pr, title });
        if (titleResult.error || titleResult.errorMessage || titleResult.status >= 400) {
          throw new CommandExecutionError(
            `修改标题失败: HTTP ${titleResult.status}${titleResult.errorMessage ? `（${titleResult.errorMessage}）` : ''}`,
          );
        }
        if (titleResult.title !== title) {
          throw new CommandExecutionError(`修改标题未生效（服务端返回: ${titleResult.title}），请到页面确认`);
        }
        wroteTitle = true;
      }

      let finalContent = null;
      let contentVersion = null;
      let bodyEditor = null;
      let bodyWriteNeeded = Boolean(body);
      if (body) {
        const clickResult = await readEditor();
        if (clickResult.error) {
          throw new CommandExecutionError('正文评论没有"编辑"菜单项，请确认有编辑权限');
        }
        const editor = await waitEditor();
        bodyEditor = editor;
        finalContent = append ? `${editor.content.replace(/\s+$/, '')}\n\n${body}` : body;
        contentVersion = Number(editor.version);
        // 线上正文已是目标内容（含只差空白/换行/转义的归一化等价）时不再重复写
        bodyWriteNeeded = append || !bodyEquivalent(finalContent, editor.content);
      }
      if (bodyWriteNeeded) {
        const contentResult = await page.evaluate(async ({ repo, pr, content, context, contentVersion }) => {
          const resp = await fetch(`/${repo}/issues/${pr}/content`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-gitea-fetch-action': '1' },
            body: new URLSearchParams({ content, context, content_version: String(contentVersion) }),
          });
          const ct = resp.headers.get('content-type') || '';
          if (!ct.includes('application/json')) return { error: 'NOT_JSON', status: resp.status };
          const data = await resp.json();
          return {
            status: resp.status,
            contentVersion: data.contentVersion ?? null,
            errorMessage: data.errorMessage || null,
          };
        }, { repo, pr, content: finalContent, context: `/${repo}`, contentVersion });
        if (contentResult.errorMessage || contentResult.status >= 400) {
          if (attempt < maxAttempts && /已被其他用户更改|content_version|conflict/i.test(contentResult.errorMessage || '')) {
            continue; // 版本过期：重新读版本号重试
          }
          throw new CommandExecutionError(
            `修改正文失败: HTTP ${contentResult.status}${contentResult.errorMessage ? `（${contentResult.errorMessage}）` : ''}`,
          );
        }
        if (contentResult.contentVersion === null) {
          throw new CommandExecutionError(`修改正文未生效（服务端未返回新版本号）`);
        }
        // 服务端已接受写入：此后不得再因"下一轮无差异"推翻结果
        wroteBody = true;
        contentVersion = contentResult.contentVersion;
      }

      // 复查：标题看渲染文本；正文重新水合编辑器比对 Markdown 原文
      await new Promise((r) => setTimeout(r, 1200));
      await openPrPage(`check-${attempt}`);
      if (title) {
        // 该实例标题渲染在 h1 内并带 "#N" 后缀（无 #issue-title-rendered）
        const rendered = await page.evaluate((pr) => {
          const el = document.querySelector('#issue-title-rendered') || document.querySelector('.issue-title h1, h1');
          let text = (el?.textContent || '').replace(/\s+/g, ' ').trim();
          return text.replace(new RegExp('#' + pr + '\\s*$'), '').trim();
        }, pr);
        if (rendered !== title.replace(/\s+/g, ' ').trim()) {
          if (attempt < maxAttempts) continue;
          throw new CommandExecutionError(`标题修改未生效（页面显示: ${rendered}），请到页面确认`);
        }
      }
      if (body) {
        const clickResult = await readEditor();
        if (!clickResult.error) {
          const after = await waitEditor();
          // 只差空白/换行/转义 => 写入算成功，不 continue 到下一轮重复写
          if (!bodyEquivalent(after.content, finalContent)) {
            const stillOld = bodyEditor ? bodyEquivalent(after.content, bodyEditor.content) : false;
            if (stillOld) {
              // 页面仍是本轮提交前的内容：这轮写入确实没生效，才允许重试
              if (attempt < maxAttempts) continue;
              throw new CommandExecutionError(
                `正文修改未生效（页面仍是修改前的内容）。${bodyDiff(finalContent, after.content)}。请到页面确认: ${prUrl}`,
              );
            }
            throw new CommandExecutionError(
              `正文修改后页面内容与提交内容不一致。${bodyDiff(finalContent, after.content)}。请到页面确认: ${prUrl}`,
            );
          }
        }
      }

      return {
        prNumber: pr,
        title: title || undefined,
        // bodyChanged 语义："本次是否真的写了正文"
        bodyChanged: wroteBody,
        changed: wroteTitle || wroteBody,
        contentVersion,
        url: prUrl,
      };
    }

    throw new CommandExecutionError(`编辑未生效（重试 ${maxAttempts} 次后仍不符）。请到页面确认: ${prUrl}`);
  },
});
