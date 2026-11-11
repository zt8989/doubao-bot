// Gitea 关闭/重开里程碑——复用浏览器登录态（无需 API token）。
// 列表页行内 link-action 按钮自带 data-url：/milestones/{id}/close 或 /open，
// 直接 POST 该地址；状态以行内按钮判断（有"关闭"= 开启中，有"重开"= 已关闭）。
// 该实例写操作偶发静默 no-op，提交后带 cache-buster 复查并重试。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'milestone-close',
  description: '关闭/重开 Gitea 里程碑（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'milestone', type: 'string', required: true, positional: true, help: '里程碑名称或 id' },
    { name: 'reopen', type: 'bool', default: false, help: '重新开启（默认是关闭）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['id', 'milestone', 'state', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const wanted = String(args.milestone ?? '').trim();
    if (!wanted) throw new ArgumentError('milestone 不能为空');
    const reopen = Boolean(args.reopen);

    // 该实例 state=all 只列开启中的里程碑，重开必须单独查 closed 列表
    const loadRows = async (stateParam, tag) => {
      try {
        await page.goto(`${BASE}/${repo}/milestones?state=${stateParam}&_=${Date.now()}-${tag}`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开里程碑列表失败: ${error?.message || error}`);
      }
      const url = await page.evaluate(() => window.location.href);
      if (/\/user\/login/.test(url)) {
        throw new CommandExecutionError('请确认登录态有效');
      }
      return page.evaluate(() =>
        [...document.querySelectorAll('.milestone-list > .item')].map((row) => {
          const titleLink = row.querySelector('.list-item-large-title a[href*="/milestone/"]');
          const actions = [...row.querySelectorAll('.link-action')]
            .map((a) => ({ url: a.getAttribute('data-url') || '', text: a.textContent.trim() }));
          return {
            id: Number(/\/milestone\/(\d+)/.exec(titleLink?.getAttribute('href') || '')?.[1]) || null,
            name: titleLink?.textContent.trim() || null,
            closeUrl: actions.find((a) => /\/close$/.test(a.url))?.url || null,
            openUrl: actions.find((a) => /\/open$/.test(a.url))?.url || null,
          };
        })
      );
    };

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const openRows = await loadRows('open', attempt);
      const closedRows = await loadRows('closed', attempt);
      const rows = [
        ...openRows.map((r) => ({ ...r, state: 'open' })),
        ...closedRows.map((r) => ({ ...r, state: 'closed' })),
      ];
      const row = rows.find((r) => r.name === wanted || String(r.id) === wanted);
      if (!row) {
        const options = rows.map((r) => `${r.id}=${r.name}`).join(', ');
        throw new CommandExecutionError(`找不到里程碑 "${wanted}"，可用: ${options || '（仓库没有里程碑）'}`);
      }

      const actionUrl = reopen ? row.openUrl : row.closeUrl;
      const expectState = reopen ? 'open' : 'closed';
      if (!actionUrl) {
        throw new EmptyResultError(
          `gitea milestone-close ${repo}`,
          reopen ? `里程碑 ${row.name} 已是开启状态，无需重开` : `里程碑 ${row.name} 已是关闭状态，无需关闭`,
        );
      }

      const result = await page.evaluate(async (url) => {
        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-gitea-fetch-action': '1' },
        });
        const ct = resp.headers.get('content-type') || '';
        return { status: resp.status, isJson: ct.includes('application/json'), body: (await resp.text()).slice(0, 200) };
      }, `${BASE}${actionUrl}`);

      if (!result.isJson || result.status >= 400) {
        throw new CommandExecutionError(
          `${reopen ? '重开' : '关闭'}里程碑失败: HTTP ${result.status}（${result.body}）。请确认登录态是否有效`,
        );
      }

      await new Promise((r) => setTimeout(r, 1500));
      const checkRows = await loadRows(expectState, `check-${attempt}`);
      const after = checkRows.find((r) => r.id === row.id);
      if (after) {
        return {
          id: row.id,
          milestone: row.name,
          state: expectState,
          url: `${BASE}/${repo}/milestone/${row.id}`,
        };
      }
    }

    throw new CommandExecutionError(`里程碑状态变更未生效（重试 ${maxAttempts} 次后仍不符）。请到页面确认`);
  },
});
