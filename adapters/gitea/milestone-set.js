// Gitea 设置/清除工单或合并请求的里程碑——复用浏览器登录态（无需 API token）。
// 工单页侧栏 milestone combo：data-update-url=/issues/milestone?issue_ids={内部id}，
// 选中项 POST update-url，body 只有 id={里程碑id}（清除为 0）；内部 id 与显示编号不同，
// 必须从页面读取。该实例写操作偶发静默 no-op，提交后带 cache-buster 复查 combo-value 并重试。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'milestone-set',
  description: '设置/清除工单或合并请求的里程碑（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单或合并请求编号，如 1' },
    { name: 'milestone', type: 'string', positional: true, help: '里程碑名称或 id；--remove 时省略' },
    { name: 'remove', type: 'bool', default: false, help: '清除里程碑' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'action', 'milestone', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }
    const remove = Boolean(args.remove);
    const wanted = String(args.milestone ?? '').trim();
    if (!remove && !wanted) throw new ArgumentError('milestone 不能为空（或使用 --remove 清除）');
    if (remove && wanted) throw new ArgumentError('--remove 与 milestone 不能同时提供');

    const readCombo = async () =>
      page.evaluate(() => {
        const combo = [...document.querySelectorAll('.issue-sidebar-combo')]
          .find((c) => c.querySelector('.combo-value')?.name === 'milestone_id');
        if (!combo) return null;
        const items = [...combo.querySelectorAll('.ui.dropdown .menu > .item')].map((el) => ({
          id: el.getAttribute('data-value'),
          name: el.textContent.trim(),
        }));
        return {
          url: window.location.href,
          updateUrl: combo.getAttribute('data-update-url'),
          current: combo.querySelector('.combo-value').value,
          items,
        };
      });

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-${attempt}`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开工单页失败: ${error?.message || error}`);
      }
      const state = await readCombo();
      if (!state || /\/user\/login/.test(state.url)) {
        throw new CommandExecutionError(`无法访问 ${repo}#${issue}：请确认登录态有效、编号存在`);
      }

      // 该实例清除里程碑与页面 UI 一致发空 id（实测 id=0 也可，但 UI 发空串，从众更稳）
      let targetId = '';
      let targetName = '(无里程碑)';
      let targetDisplay = '0';
      if (!remove) {
        const item = state.items.find((it) => it.id && (it.name === wanted || it.id === wanted));
        if (!item) {
          const options = state.items.filter((it) => it.id).map((it) => `${it.id}=${it.name}`).join(', ');
          throw new CommandExecutionError(
            `找不到里程碑 "${wanted}"，可用: ${options || '（仓库还没有里程碑，先用 gitea milestone-create 创建）'}`,
          );
        }
        targetId = item.id;
        targetName = item.name;
        targetDisplay = item.id;
      }

      const alreadyCleared = state.current === '0' || state.current === '';
      if (remove ? alreadyCleared : state.current === targetId) {
        throw new EmptyResultError(
          `gitea milestone-set ${repo}#${issue}`,
          remove ? '工单未设置里程碑，无需清除' : `里程碑已经是 ${targetName}，无需重复设置`,
        );
      }

      const result = await page.evaluate(async ({ updateUrl, id }) => {
        const resp = await fetch(updateUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-gitea-fetch-action': '1' },
          body: new URLSearchParams({ id }),
        });
        const ct = resp.headers.get('content-type') || '';
        return { status: resp.status, isJson: ct.includes('application/json'), body: (await resp.text()).slice(0, 200) };
      }, { updateUrl: state.updateUrl, id: targetId });

      if (!result.isJson || result.status >= 400) {
        throw new CommandExecutionError(
          `设置里程碑失败: HTTP ${result.status}（${result.body}）。请确认登录态是否有效`,
        );
      }

      // 等服务端落库后，带新 cache-buster 复查；若服务端 no-op 则重试
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-check-${attempt}`, { waitUntil: 'load', timeout: 15000 });
      } catch {
        continue;
      }
      const after = await readCombo();
      const afterCleared = after?.current === '0' || after?.current === '';
      if (remove ? afterCleared : after?.current === targetDisplay) {
        return {
          issueNumber: issue,
          action: remove ? 'cleared' : 'set',
          milestone: remove ? '(none)' : targetName,
          url: `${BASE}/${repo}/issues/${issue}`,
        };
      }
    }

    throw new CommandExecutionError(`里程碑变更未生效（重试 ${maxAttempts} 次后仍不符）。请到页面确认`);
  },
});
