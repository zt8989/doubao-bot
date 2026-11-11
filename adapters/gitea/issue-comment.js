// Gitea 工单评论——复用浏览器登录态，重放 #comment-form 的同款 AJAX（无需 API token）。
// 该表单 POST 到 /issues/{n}/comments，服务端带 x-gitea-fetch-action 头时返回 JSON {redirect}，
// redirect 里的 #issuecomment-<id> 即新评论编号；评论没有幂等性，验证失败只报错不重发。
// 落库验证比对用 .raw-content 原文（innerText 是渲染文本，Markdown 语法已转格式，不能验原文）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { openIssuePage } from './utils.js';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'issue-comment',
  description: '在 Gitea 工单下发表评论（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'body', type: 'string', required: true, positional: true, help: '评论正文（Markdown）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'commentId', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }
    const body = String(args.body ?? '').trim();
    if (!body) throw new ArgumentError('body 不能为空');

    await openIssuePage(page, repo, issue, 'comment');

    const result = await page.evaluate(async ({ content }) => {
      const form = document.querySelector('form#comment-form');
      if (!form) return { error: 'NO_FORM' };
      const fd = new FormData(form);
      fd.set('content', content);
      const resp = await fetch(form.action, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        headers: { 'x-gitea-fetch-action': '1' },
      });
      const ct = resp.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
      return { status: resp.status, isJson: Boolean(data), redirect: data?.redirect || null, errorMessage: data?.errorMessage || null };
    }, { content: body });

    if (result.error === 'NO_FORM') {
      throw new CommandExecutionError(`工单 ${repo}#${issue} 页面没有评论输入框，请确认有评论权限`);
    }
    if (result.status === 401 || result.status === 403) {
      throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    }
    if (!result.isJson || result.status >= 400 || result.errorMessage) {
      throw new CommandExecutionError(
        `发表评论失败: HTTP ${result.status}${result.errorMessage ? `（${result.errorMessage}）` : ''}`,
      );
    }

    const commentId = Number(/#issuecomment-(\d+)/.exec(result.redirect || '')?.[1]) || null;

    // 复查：刷新工单页确认评论已落库；拿到编号时只认该编号，避免误判他人评论
    await new Promise((r) => setTimeout(r, 800));
    await openIssuePage(page, repo, issue, 'comment-check');
    const verified = await page.evaluate(({ id, content }) => {
      const items = [...document.querySelectorAll('.timeline-item.comment')]
        .filter((it) => !it.classList.contains('issue-content-comment') && !it.classList.contains('form'));
      if (id) {
        const el = document.querySelector(`#issuecomment-${id}`);
        return { found: Boolean(el), text: el?.querySelector('.comment-body')?.innerText.trim() || null };
      }
      const last = items[items.length - 1];
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const raw = last?.querySelector('.raw-content')?.textContent ?? last?.querySelector('.comment-body')?.innerText;
      return { found: norm(raw) === norm(content), text: null };
    }, { id: commentId, content: body });

    if (!verified.found) {
      throw new CommandExecutionError(
        commentId
          ? `评论提交返回成功，但刷新后找不到评论 #${commentId}，请到 ${BASE}/${repo}/issues/${issue} 确认`
          : `评论提交后无法确认落库（响应未带评论编号，最后一条评论也不匹配），请到 ${BASE}/${repo}/issues/${issue} 确认`,
      );
    }

    return {
      issueNumber: issue,
      commentId,
      url: `${BASE}/${repo}/issues/${issue}${commentId ? `#issuecomment-${commentId}` : ''}`,
    };
  },
});
