// Gitea 删除里程碑——复用浏览器登录态（无需 API token）。
// 列表页行内 link-action 按钮自带 data-url /milestones/delete?id={id}，直接 POST，
// 成功返回 JSON {redirect}；删除会把工单上的该里程碑标记一并清除。
// 该实例 state=all 只列开启中的里程碑，定位前先查 open 与 closed 两趟列表；
// 写操作偶发静默 no-op，提交后带 cache-buster 复查行已消失，未消失则重试。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'milestone-delete',
  description: '删除 Gitea 仓库里程碑（工单上的该里程碑标记会被一并清除）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'milestone', type: 'string', required: true, positional: true, help: '里程碑名称或 id' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['id', 'milestone', 'deleted'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const wanted = String(args.milestone ?? '').trim();
    if (!wanted) throw new ArgumentError('milestone 不能为空');

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
            deleteUrl: actions.find((a) => /\/milestones\/delete\?id=\d+/.test(a.url))?.url || null,
          };
        })
      );
    };

    const findAllRows = async (tag) => {
      const openRows = await loadRows('open', `${tag}-open`);
      const closedRows = await loadRows('closed', `${tag}-closed`);
      return [
        ...openRows.map((r) => ({ ...r, state: 'open' })),
        ...closedRows.map((r) => ({ ...r, state: 'closed' })),
      ];
    };

    const row = (await findAllRows('locate'))
      .find((r) => r.name === wanted || String(r.id) === wanted);
    if (!row) {
      const rows = await findAllRows('locate-opts');
      const options = rows.map((r) => `${r.id}=${r.name}`).join(', ');
      throw new CommandExecutionError(`找不到里程碑 "${wanted}"，可用: ${options || '（仓库没有里程碑）'}`);
    }
    if (!row.id || !row.deleteUrl) {
      throw new CommandExecutionError(`里程碑 "${row.name}" 行内未找到删除入口（data-url），请到页面确认`);
    }

    const postDelete = () =>
      page.evaluate(async (url) => {
        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-gitea-fetch-action': '1' },
        });
        const ct = resp.headers.get('content-type') || '';
        const bodyText = await resp.text();
        return { status: resp.status, isJson: ct.includes('application/json'), body: bodyText.slice(0, 200) };
      }, `${BASE}${row.deleteUrl}`);

    // 删除成功后该行（按 id）不再出现在 open/closed 任一列表
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await postDelete();
      if (!result.isJson || result.status >= 400) {
        throw new CommandExecutionError(
          `删除里程碑失败: HTTP ${result.status}（${result.body}）。请确认登录态是否有效`,
        );
      }

      await new Promise((r) => setTimeout(r, 1500));
      const still = (await findAllRows(`check-${attempt}`)).find((r) => r.id === row.id);
      if (!still) {
        return { id: row.id, milestone: row.name, deleted: true };
      }
    }

    throw new CommandExecutionError(
      `删除请求已受理（HTTP 200）但复查中里程碑 "${row.name}" 仍在列表（疑似服务端静默 no-op），请到 ${BASE}/${repo}/milestones 确认后重试`,
    );
  },
});
