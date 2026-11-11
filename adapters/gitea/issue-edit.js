// Gitea 编辑工单标题/正文/标签——复用浏览器登录态（无需 API token）。
// 标题/正文复用 PR 同款端点（编号与工单同序）：POST /issues/{n}/title {title}；
// POST /issues/{n}/content {content, context, content_version}，content_version 是乐观锁，
// 需点正文评论菜单"编辑"水合编辑器后从 data-content-version 读取，版本过期返回 400。
// 标签走侧栏 combo 的 diff 协议：data-update-url 已带内部 issue id，
// 逐项 POST {action: attach|detach, id}，返回 {ok:true}；该实例写操作偶发静默 no-op，
// 每轮都刷新页面复查 combo-value 并重试剩余差异。
// 结果语义：无差异是成功（ok:true + changed:false），不是 EmptyResultError；
// 某轮已拿到新 contentVersion 就算写过，后续复查不得再把整次结果推翻成失败。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { openIssuePage, readIssueSidebar, bodyEquivalent, bodyDiff } from './utils.js';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

const splitList = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

cli({
  site: 'gitea',
  name: 'issue-edit',
  description: '编辑 Gitea 工单标题/正文/标签（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'title', type: 'string', default: '', help: '新标题，省略则不修改' },
    { name: 'body', type: 'string', default: '', help: '新正文（Markdown），省略则不修改' },
    { name: 'append', type: 'bool', default: false, help: '把 body 追加到现有正文末尾' },
    { name: 'label-add', type: 'string', default: '', help: '要添加的标签，名称或 id，逗号分隔多个' },
    { name: 'label-remove', type: 'string', default: '', help: '要移除的标签，名称或 id，逗号分隔多个' },
    { name: 'set-labels', type: 'string', default: '', help: '全量设置标签（替换现有集合），名称或 id，逗号分隔；与 add/remove 互斥' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'title', 'labels', 'bodyChanged', 'changed', 'contentVersion', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '');
    const append = Boolean(args.append);
    const labelAdd = splitList(args['label-add']);
    const labelRemove = splitList(args['label-remove']);
    const setLabels = splitList(args['set-labels']);
    if (!title && !body && !labelAdd.length && !labelRemove.length && !setLabels.length) {
      throw new ArgumentError('至少提供 title、body、label-add、label-remove、set-labels 之一');
    }
    if (append && !body) throw new ArgumentError('append 模式需要提供 body（要追加的内容）');
    if (setLabels.length && (labelAdd.length || labelRemove.length)) {
      throw new ArgumentError('set-labels 与 label-add/label-remove 不能同时使用');
    }
    const url = `${BASE}/${repo}/issues/${issue}`;

    const editItemSelector = () =>
      page.evaluate(() => {
        const comment = document.querySelector('.issue-content-comment');
        const editItem = comment?.querySelector('.menu > .item.edit-content')
          || [...(comment?.querySelectorAll('.menu > .item') || [])].find((it) => it.textContent.trim() === '编辑');
        if (!editItem) return false;
        editItem.click();
        return true;
      });

    const readEditor = () =>
      page.evaluate(() => {
        const comment = document.querySelector('.issue-content-comment');
        return {
          version: comment?.querySelector('[data-content-version]')?.getAttribute('data-content-version') ?? null,
          content: comment?.querySelector('textarea[name=content]')?.value ?? null,
        };
      });

    const waitEditor = async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const s = await readEditor();
        if (s.version !== null && s.version !== 'undefined' && s.content !== null) return s;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new CommandExecutionError('正文编辑器未水合，读不到 content_version，请刷新后重试');
    };

    // 名称或 id -> 标签 id；name 来自 combo 菜单项（含组织级标签）
    const resolveLabels = (items, wanted) => {
      const byName = new Map(items.map((it) => [it.name, it.id]));
      const known = new Set(items.map((it) => it.id));
      const ids = [];
      const missing = [];
      for (const w of wanted) {
        const id = known.has(w) ? w : byName.get(w);
        if (id) ids.push(id);
        else missing.push(w);
      }
      return { ids: [...new Set(ids)], missing, available: items.map((it) => `${it.name}=${it.id}`) };
    };

    const maxAttempts = 3;
    // 跨轮状态：只要某一轮真的写成功了（拿到新 contentVersion / 服务端接受标题 / 标签请求返回 JSON），
    // 后面任何一轮都不得再因为"这轮发现无差异"把整次结果判成失败。
    let wroteTitle = false;
    let wroteBody = false;
    let wroteLabels = false;
    let lastContentVersion = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await openIssuePage(page, repo, issue, `edit-${attempt}`);
      const sidebar = await readIssueSidebar(page);
      if (!sidebar.labels) {
        throw new CommandExecutionError(`页面 ${repo}#${issue} 未找到标签侧栏，请确认有工单编辑权限`);
      }

      const currentIds = sidebar.labels.value.split(',').map((s) => s.trim()).filter(Boolean);
      const currentTitle = await page.evaluate((n) => {
        const el = document.querySelector('#issue-title-rendered') || document.querySelector('.issue-title h1, h1');
        return (el?.textContent || '').replace(/\s+/g, ' ').trim().replace(new RegExp(`#\\s*${n}\\s*$`), '').trim();
      }, issue);

      let editor = null;
      if (body) {
        if (!await editItemSelector()) {
          throw new CommandExecutionError('正文评论没有"编辑"菜单项，请确认有编辑权限');
        }
        editor = await waitEditor();
      }

      let finalContent = null;
      if (body) {
        finalContent = append ? `${editor.content.replace(/\s+$/, '')}\n\n${body}` : body;
      }

      // 标签目标集合：set 全量替换；add/remove 在当前集合上增减
      let desiredIds = currentIds;
      if (setLabels.length) {
        const { ids, missing, available } = resolveLabels(sidebar.labels.items, setLabels);
        if (missing.length) {
          throw new CommandExecutionError(
            `仓库中找不到标签 ${missing.map((m) => `"${m}"`).join(', ')}，可用: ${available.join(', ') || '（仓库还没有标签，先用 gitea label-create 创建）'}`,
          );
        }
        desiredIds = ids;
      } else if (labelAdd.length || labelRemove.length) {
        const add = resolveLabels(sidebar.labels.items, labelAdd);
        const remove = resolveLabels(sidebar.labels.items, labelRemove);
        const missing = [...add.missing, ...remove.missing];
        if (missing.length) {
          throw new CommandExecutionError(
            `仓库中找不到标签 ${missing.map((m) => `"${m}"`).join(', ')}，可用: ${add.available.join(', ') || '（仓库还没有标签，先用 gitea label-create 创建）'}`,
          );
        }
        const removeSet = new Set(remove.ids);
        const next = new Set(currentIds.filter((id) => !removeSet.has(id)));
        for (const id of add.ids) next.add(id);
        desiredIds = [...next];
      }

      const doTitle = Boolean(title) && norm(title) !== norm(currentTitle);
      // 只差空白/换行/转义时视为"线上已经是目标内容"，不再重复写（幂等提交不应产生写入）
      const doBody = Boolean(body) && (append || !bodyEquivalent(finalContent, editor.content));
      const labelChanged = desiredIds.slice().sort().join(',') !== currentIds.slice().sort().join(',');

      if (!doTitle && !doBody && !labelChanged) {
        const what = [title && '标题', body && '正文', (labelAdd.length || labelRemove.length || setLabels.length) && '标签'].filter(Boolean).join('/');
        const changed = wroteTitle || wroteBody || wroteLabels;
        const nameById = new Map(sidebar.labels.items.map((it) => [it.id, it.name]));
        return {
          issueNumber: issue,
          title: doTitle ? title : undefined,
          labels: currentIds.map((id) => ({ id, name: nameById.get(id) || null })),
          // bodyChanged 语义："本次是否真的写了正文"
          bodyChanged: wroteBody,
          changed,
          contentVersion: lastContentVersion ?? (editor?.version != null ? Number(editor.version) : undefined),
          note: changed
            ? `已完成修改并复查生效（本轮写入了${[wroteTitle && '标题', wroteBody && '正文', wroteLabels && '标签'].filter(Boolean).join('/')}）`
            : `${what || '目标字段'}已与目标一致，无需修改（未变更）`,
          url,
        };
      }

      if (doTitle) {
        const result = await page.evaluate(async ({ repo, issue, title }) => {
          const resp = await fetch(`/${repo}/issues/${issue}/title`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-gitea-fetch-action': '1' },
            body: new URLSearchParams({ title }),
          });
          const ct = resp.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
          return { status: resp.status, title: data?.title ?? null, errorMessage: data?.errorMessage ?? null };
        }, { repo, issue, title });
        if (result.errorMessage || result.status >= 400 || result.title !== title) {
          if (attempt < maxAttempts) continue;
          throw new CommandExecutionError(
            `修改标题未生效: HTTP ${result.status}${result.errorMessage ? `（${result.errorMessage}）` : ''}，请到页面确认`,
          );
        }
        wroteTitle = true;
      }

      if (labelChanged) {
        const toDetach = currentIds.filter((id) => !desiredIds.includes(id));
        const toAttach = desiredIds.filter((id) => !currentIds.includes(id));
        for (const [action, ids] of [['detach', toDetach], ['attach', toAttach]]) {
          for (const id of ids) {
            const result = await page.evaluate(async ({ updateUrl, action, id }) => {
              const resp = await fetch(updateUrl, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-gitea-fetch-action': '1' },
                body: new URLSearchParams({ action, id }),
              });
              const ct = resp.headers.get('content-type') || '';
              return { status: resp.status, isJson: ct.includes('application/json'), body: (await resp.text()).slice(0, 150) };
            }, { updateUrl: sidebar.labels.updateUrl, action, id });
            if (!result.isJson || result.status >= 400) {
              throw new CommandExecutionError(
                `标签变更失败（${action} ${id}）: HTTP ${result.status}（${result.body}），请确认登录态有效`,
              );
            }
          }
        }
        wroteLabels = true;
      }

      if (doBody) {
        const result = await page.evaluate(async ({ repo, issue, content, context, contentVersion }) => {
          const resp = await fetch(`/${repo}/issues/${issue}/content`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-gitea-fetch-action': '1' },
            body: new URLSearchParams({ content, context, content_version: String(contentVersion) }),
          });
          const ct = resp.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
          return { status: resp.status, contentVersion: data?.contentVersion ?? null, errorMessage: data?.errorMessage ?? null };
        }, { repo, issue, content: finalContent, context: `/${repo}`, contentVersion: Number(editor.version) });
        if (result.errorMessage || result.status >= 400) {
          // 版本过期（内容已被他人更改）：重新读版本号重试
          if (attempt < maxAttempts && /已被其他用户更改|content_version|conflict/i.test(result.errorMessage || '')) continue;
          throw new CommandExecutionError(
            `修改正文失败: HTTP ${result.status}${result.errorMessage ? `（${result.errorMessage}）` : ''}`,
          );
        }
        if (result.contentVersion === null) {
          throw new CommandExecutionError('修改正文未生效（服务端未返回新版本号）');
        }
        // 服务端已接受写入（返回了新版本号）：从这一刻起，本次结果不再允许被"无差异"推翻
        wroteBody = true;
        lastContentVersion = result.contentVersion;
      }

      // 复查：标题看渲染文本、标签看 combo-value、正文重新水合编辑器比对 Markdown 原文
      await new Promise((r) => setTimeout(r, 1000));
      await openIssuePage(page, repo, issue, `edit-check-${attempt}`);
      const after = await readIssueSidebar(page);
      const afterIds = after.labels.value.split(',').map((s) => s.trim()).filter(Boolean);
      const sameLabels = (list) => list.slice().sort().join(',') === afterIds.slice().sort().join(',');

      if (doTitle) {
        const rendered = await page.evaluate((n) => {
          const el = document.querySelector('#issue-title-rendered') || document.querySelector('.issue-title h1, h1');
          return (el?.textContent || '').replace(/\s+/g, ' ').trim().replace(new RegExp(`#\\s*${n}\\s*$`), '').trim();
        }, issue);
        if (rendered !== norm(title)) {
          if (attempt < maxAttempts) continue;
          throw new CommandExecutionError(`标题修改未生效（页面显示: ${rendered}），请到页面确认`);
        }
      }
      if (labelChanged && !sameLabels(desiredIds)) {
        if (attempt < maxAttempts) continue;
        throw new CommandExecutionError(
          `标签变更未生效（期望: ${desiredIds.join(',') || '(空)'}，页面: ${afterIds.join(',') || '(空)'}），请到页面确认`,
        );
      }
      if (doBody) {
        const clicked = await editItemSelector();
        if (clicked) {
          const afterContent = await waitEditor();
          // 只差空白/换行/转义 => 视为写入成功，不能 continue 到下一轮去撞"无变化"
          if (!bodyEquivalent(afterContent.content, finalContent)) {
            const stillOld = bodyEquivalent(afterContent.content, editor.content);
            if (stillOld) {
              // 页面仍是本轮提交前的内容：这轮写入确实没生效，才允许重试
              if (attempt < maxAttempts) continue;
              throw new CommandExecutionError(
                `正文修改未生效（页面仍是修改前的内容）。${bodyDiff(finalContent, afterContent.content)}。请到页面确认: ${url}`,
              );
            }
            // 内容变了但不是提交的内容（服务端改写或他人并发改动）
            throw new CommandExecutionError(
              `正文修改后页面内容与提交内容不一致。${bodyDiff(finalContent, afterContent.content)}。请到页面确认: ${url}`,
            );
          }
        }
      }

      const nameById = new Map(after.labels.items.map((it) => [it.id, it.name]));
      return {
        issueNumber: issue,
        title: doTitle ? title : undefined,
        labels: afterIds.map((id) => ({ id, name: nameById.get(id) || null })),
        bodyChanged: wroteBody,
        changed: wroteTitle || wroteBody || wroteLabels,
        contentVersion: lastContentVersion ?? undefined,
        url,
      };
    }

    throw new CommandExecutionError(`编辑未生效（重试 ${maxAttempts} 次后仍不符）。请到页面确认: ${url}`);
  },
});
