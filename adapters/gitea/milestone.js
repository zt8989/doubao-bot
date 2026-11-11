// Gitea 里程碑列表——复用浏览器登录态，解析里程碑列表页 HTML。
// 行结构：.milestone-list > .item（标题链接 /milestone/{id}、progress 进度、
// 开启/关闭计数、updated 与截止日期两个 relative-time、.render-content 描述、
// link-action 按钮 data-url 带 /close 或 /open 可判断状态）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'milestone',
  description: '列出 Gitea 仓库里程碑（复用 Chrome 已登录会话）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'query', type: 'string', positional: true, default: '', help: '关键词，命中里程碑标题；省略则列出全部' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '里程碑状态' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['id', 'name', 'state', 'percent', 'openCount', 'closedCount', 'due', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const query = String(args.query ?? '').trim();
    const pageNum = Number(args.page) || 1;
    if (!Number.isInteger(pageNum) || pageNum <= 0) throw new ArgumentError(`page 必须是正整数，当前: "${args.page}"`);

    const url = new URL(`${BASE}/${repo}/milestones`);
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('state', args.state);
    if (pageNum > 1) url.searchParams.set('page', String(pageNum));

    const gotoList = async (stateParam, tag) => {
      const u = new URL(url.href);
      u.searchParams.set('state', stateParam);
      u.searchParams.set('_', `${Date.now()}-${tag}`);
      try {
        await page.goto(u.href, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开 ${u.href} 失败: ${error?.message || error}`);
      }
      const pageState = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
      }));
      if (/\/user\/login/.test(pageState.url)) {
        throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
      }
      if (/Page Not Found|404/.test(pageState.title)) {
        throw new CommandExecutionError(`仓库 ${repo} 不存在或无权限访问`);
      }
    };

    const parseRows = (stateLabel) =>
      page.evaluate((label) =>
        [...document.querySelectorAll('.milestone-list > .item')].map((row) => {
          const titleLink = row.querySelector('.list-item-large-title a[href*="/milestone/"]');
          const id = Number(/\/milestone\/(\d+)/.exec(titleLink?.getAttribute('href') || '')?.[1]) || null;
          const closeLink = [...row.querySelectorAll('.link-action')].find((a) => /\/close$/.test(a.getAttribute('data-url') || ''));
          const openLink = [...row.querySelectorAll('.link-action')].find((a) => /\/open$/.test(a.getAttribute('data-url') || ''));
          const dueEl = [...row.querySelectorAll('.flex-text-inline')]
            .find((d) => d.querySelector('.octicon-calendar'))
            ?.querySelector('relative-time');
          return {
            id,
            name: titleLink?.textContent.trim() || null,
            state: label,
            percent: Number(row.querySelector('progress.list-item-title-progress')?.value) || 0,
            openCount: Number(/(\d+)\s*开启中/.exec(row.textContent)?.[1]) || 0,
            closedCount: Number(/(\d+)\s*已关闭/.exec(row.textContent)?.[1]) || 0,
            due: dueEl?.getAttribute('datetime')?.slice(0, 10) || null,
            url: titleLink ? new URL(titleLink.getAttribute('href'), window.location.origin).href : null,
            description: row.querySelector('.render-content')?.textContent.trim() || null,
          };
        })
      , stateLabel);

    // 该实例 state=all 只列开启中的里程碑，all 需合并 open+closed 两页
    let rows;
    if (args.state === 'all') {
      await gotoList('open', 'a');
      rows = await parseRows('open');
      await gotoList('closed', 'b');
      rows = rows.concat(await parseRows('closed'));
    } else {
      await gotoList(args.state, 's');
      rows = await parseRows(args.state);
    }
    return rows;
  },
});
