// Gitea 顶部导航聚合页——工单(/issues)、合并请求(/pulls)、里程碑(/milestones)、探索(/explore/repos)。
// 范围为登录用户视角的跨仓库聚合（Gitea 顶部导航本身就是"与我相关"口径）。
// issues/pulls 行与仓库内列表同款模板（a.list-item-large-title → .item，a.index 文本含 repo#编号），
// 但状态图标不同：PR 用 octicon-git-pull-request=开启 / git-merge=已合并 / issue-closed=已关闭；
// 全局里程碑行是 .item.flex-relaxed-list，repo 名在 .ui.large.label；探索页仓库行 .item 内含两个 a.name。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const KINDS = ['issues', 'pulls', 'milestones', 'repos'];
const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'explore',
  description: '顶部导航聚合页：所有工单 / 合并请求 / 里程碑 / 仓库（跨仓库，登录用户视角）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'kind', type: 'string', required: true, positional: true, choices: KINDS, help: '聚合类型: issues=工单, pulls=合并请求, milestones=里程碑, repos=仓库(探索)' },
    { name: 'query', type: 'string', positional: true, default: '', help: '关键词；repos 时命中仓库名/描述，issues/pulls 时命中标题' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '状态（repos 忽略）' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['kind', 'repo', 'number', 'title', 'state', 'url'],
  func: async (page, args) => {
    const kind = String(args.kind || '');
    if (!KINDS.includes(kind)) throw new ArgumentError(`kind 必须是 ${KINDS.join('/')}`);
    const query = String(args.query ?? '').trim();
    const pageNum = Number(args.page) || 1;
    if (!Number.isInteger(pageNum) || pageNum <= 0) throw new ArgumentError(`page 必须是正整数，当前: "${args.page}"`);

    const url = new URL(`${BASE}/`);
    if (kind === 'issues') {
      url.pathname = '/issues';
      url.searchParams.set('type', 'issues');
      url.searchParams.set('state', args.state);
    } else if (kind === 'pulls') {
      url.pathname = '/pulls';
      url.searchParams.set('state', args.state);
    } else if (kind === 'milestones') {
      url.pathname = '/milestones';
      url.searchParams.set('state', args.state === 'all' ? 'all' : args.state);
    } else {
      url.pathname = '/explore/repos';
    }
    if (query) url.searchParams.set('q', query);
    if (pageNum > 1) url.searchParams.set('page', String(pageNum));

    try {
      await page.goto(url.href, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开 ${url.href} 失败: ${error?.message || error}`);
    }
    const pageState = await page.evaluate(() => window.location.href);
    if (/\/user\/login/.test(pageState)) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);

    if (kind === 'issues' || kind === 'pulls') {
      const isPull = kind === 'pulls';
      return page.evaluate((kindTag) => {
        const stateOf = (row) => {
          const ic = (name) => !!row.querySelector(`.octicon-${name}`);
          if (kindTag === 'pulls') {
            return ic('git-merge') ? 'merged' : ic('issue-closed') ? 'closed' : ic('git-pull-request') ? 'open' : null;
          }
          return ic('issue-opened') ? 'open' : ic('issue-closed') ? 'closed' : null;
        };
        const rows = [...document.querySelectorAll('a.list-item-large-title')]
          .map((a) => a.closest('.item'))
          .filter(Boolean);
        return rows.map((row) => {
          const titleLink = row.querySelector('a.list-item-large-title');
          const href = titleLink.getAttribute('href') || '';
          const m = /^\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)/.exec(href) || [];
          const times = [...row.querySelectorAll('relative-time')].map((t) => t.getAttribute('datetime'));
          const commentEl = [...row.querySelectorAll('.octicon-comment')].pop();
          const comments = commentEl
            ? Number((commentEl.parentElement?.textContent || '').replace(/[^\d]/g, '')) || 0
            : 0;
          return {
            kind: kindTag,
            repo: m[1] || null,
            number: Number(m[3]) || null,
            title: titleLink.textContent.trim(),
            state: stateOf(row),
            author: row.querySelector('.item-body a[href^="/"]:not(.index)')?.textContent.trim() || null,
            createdAt: times[0] || null,
            updatedAt: times.length > 1 ? times[times.length - 1] : times[0] || null,
            comments,
            labels: [...row.querySelectorAll('.labels-list .ui-label')]
              .map((l) => l.getAttribute('data-tooltip-content') || l.textContent.trim()),
            assignees: [...row.querySelectorAll('img.avatar[title]')].map((i) => i.getAttribute('title')),
            url: new URL(href, window.location.origin).href,
          };
        });
      }, kind);
    }

    if (kind === 'milestones') {
      return page.evaluate((kindTag) => {
        const rows = [...document.querySelectorAll('.item.flex-relaxed-list')];
        return rows.map((row) => {
          const msLink = row.querySelector('a[href*="/milestone/"]');
          const m = /^\/([^/]+\/[^/]+)\/milestone\/(\d+)/.exec(msLink?.getAttribute('href') || '') || [];
          const text = row.textContent;
          const pct = /(\d+)%/.exec(text)?.[1];
          const cnt = (word) => {
            const n = new RegExp(`(\\d+)\\s*${word}`).exec(text)?.[1];
            return n ? Number(n) : 0;
          };
          const dueEl = row.querySelector('relative-time');
          return {
            kind: kindTag,
            repo: row.querySelector('.ui.large.label')?.textContent.trim() || m[1] || null,
            id: Number(m[2]) || null,
            title: msLink?.textContent.trim() || null,
            percent: pct ? Number(pct) : null,
            openCount: cnt('开启中'),
            closedCount: cnt('已关闭'),
            due: dueEl?.getAttribute('datetime') || null,
            state: /关闭/.test(row.querySelector('.link-action, [data-url*="/close"], [data-url*="/open"]')?.textContent || '关闭') ? 'open' : 'closed',
            url: new URL(msLink?.getAttribute('href') || '', window.location.origin).href,
          };
        });
      }, kind);
    }

    return page.evaluate((kindTag) => {
      const rows = [...document.querySelectorAll('.item')].filter((r) => r.querySelector('.item-title a[href*="/src/"], .item-title a.name'));
      return rows.map((row) => {
        const names = [...row.querySelectorAll('.item-title a.name')].map((a) => a.textContent.trim());
        const href = row.querySelector('.item-title a[href^="/"]')?.getAttribute('href') || '';
        const owner = names.length > 1 ? names[0] : null;
        const repo = names.length > 1 ? names.slice(1).join('/') : names[0] || null;
        return {
          kind: kindTag,
          owner,
          repo,
          name: owner ? `${owner}/${repo}` : repo,
          title: owner ? `${owner}/${repo}` : repo,
          description: row.querySelector('.item-description')?.textContent.trim() || null,
          updatedAt: row.querySelector('relative-time')?.getAttribute('datetime') || null,
          url: new URL(href, window.location.origin).href,
        };
      });
    }, kind);
  },
});
