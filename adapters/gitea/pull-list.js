// Gitea 仓库合并请求列表——复用浏览器登录态，解析 /<repo>/pulls 列表页 HTML。
// 与 search 的区别：search 走 type=issues 排除合并请求，这条专列 PR，并带回 author 便于按人过滤。
// 列表页不回 base/head 分支，要看分支信息仍然用 pr-view。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'pull-list',
  description: '列出 Gitea 仓库的合并请求（复用 Chrome 已登录会话）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: BASE,
  args: [
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '合并请求状态' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['number', 'state', 'title', 'author', 'labels', 'createdAt', 'updatedAt', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const state = String(args.state ?? 'open');
    if (!STATES.includes(state)) throw new ArgumentError(`state 必须是 ${STATES.join('/')}，当前: "${state}"`);
    const pageNum = Number(args.page) || 1;
    if (!Number.isInteger(pageNum) || pageNum <= 0) throw new ArgumentError(`page 必须是正整数，当前: "${args.page}"`);

    const url = new URL(`${BASE}/${repo}/pulls`);
    url.searchParams.set('state', state);
    if (pageNum > 1) url.searchParams.set('page', String(pageNum));
    url.searchParams.set('_', String(Date.now()));

    try {
      await page.goto(url.href, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开 ${url.href} 失败: ${error?.message || error}`);
    }

    const pageState = await page.evaluate(() => ({
      url: window.location.href,
      notFound: /Page Not Found/i.test(document.title),
      hasList: !!document.querySelector('.list-item-large-title'),
    }));
    if (pageState.notFound) throw new CommandExecutionError(`仓库或路径不存在（404）：${repo}（Gitea 仓库名区分大小写）`);
    if (/\/user\/login/.test(pageState.url)) {
      throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    }
    if (!pageState.hasList) return [];

    return page.evaluate((repoName) => {
      const stateOf = (row) => {
        const ic = (name) => !!row.querySelector(`.octicon-${name}`);
        return ic('git-merge') ? 'merged' : ic('issue-closed') ? 'closed' : ic('git-pull-request') ? 'open' : null;
      };
      const rows = [...document.querySelectorAll('a.list-item-large-title')]
        .map((a) => a.closest('.item'))
        .filter(Boolean);
      return rows
        .map((row) => {
          const titleLink = row.querySelector('a.list-item-large-title');
          const href = titleLink.getAttribute('href') || '';
          const m = /^\/([^/]+\/[^/]+)\/(?:pulls|issues)\/(\d+)/.exec(href) || [];
          if (!m[2]) return null;
          const times = [...row.querySelectorAll('relative-time')].map((t) => t.getAttribute('datetime'));
          const authorLink = row.querySelector('.item-body a[href^="/"]:not(.index)');
          return {
            number: Number(m[2]),
            repo: m[1] || repoName,
            state: stateOf(row),
            title: titleLink.textContent.replace(/\s+/g, ' ').trim(),
            author: authorLink?.textContent.trim() || null,
            labels: [...row.querySelectorAll('.labels-list .ui-label')]
              .map((l) => l.getAttribute('data-tooltip-content') || l.textContent.trim())
              .filter(Boolean),
            assignees: [...row.querySelectorAll('img.avatar[title]')].map((i) => i.getAttribute('title')).filter(Boolean),
            createdAt: times[0] || null,
            updatedAt: times.length > 1 ? times[times.length - 1] : times[0] || null,
            url: new URL(href, window.location.origin).href,
          };
        })
        .filter(Boolean);
    }, repo);
  },
});
