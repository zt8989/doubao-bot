// Gitea 设置/清除工单截止日期——复用浏览器登录态（无需 API token）。
// 提交走页面 .issue-due-form（form-fetch-action）同款 AJAX：FormData{deadline} POST 到 /issues/{n}/deadline。
// 注意：该实例写操作偶发静默 no-op，且工单页有 Chrome 启发式缓存，复查带 cache-buster 并按需重试。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

cli({
  site: 'gitea',
  name: 'due',
  description: '设置/清除 Gitea 工单截止日期（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'date', type: 'string', required: true, positional: true, help: '截止日期 YYYY-MM-DD，或 clear 清除' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'deadline', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }
    const raw = String(args.date ?? '').trim();
    const clear = /^clear$/i.test(raw);
    if (!clear && !DATE_RE.test(raw)) {
      throw new ArgumentError(`date 必须是 YYYY-MM-DD 或 clear，当前: "${raw}"`);
    }
    // 规范化日期（补零已在正则保证；转 Date 校验真实性）
    if (!clear) {
      const d = new Date(`${raw}T00:00:00`);
      if (Number.isNaN(d.getTime())) throw new ArgumentError(`date 不是有效日期: "${raw}"`);
    }

    const readDue = async () =>
      page.evaluate(() => {
        const form = document.querySelector('.issue-due-form');
        if (!form) return null;
        const current = form.parentElement.textContent.replace(/\s+/g, ' ').trim();
        return {
          url: window.location.href,
          isUnset: !current || /未设置截止日期/.test(current),
          current,
        };
      });

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-${attempt}`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开工单页失败: ${error?.message || error}`);
      }
      const state = await readDue();
      if (!state || /\/user\/login/.test(state.url)) {
        throw new CommandExecutionError(
          `无法访问工单 ${repo}#${issue}：请确认登录态有效、工单编号存在`,
        );
      }

      if (clear && state.isUnset) {
        throw new EmptyResultError(`gitea due ${repo}#${issue}`, '工单未设置截止日期，无需清除');
      }
      if (!clear && state.current === raw) {
        throw new EmptyResultError(`gitea due ${repo}#${issue}`, `截止日期已经是 ${raw}，无需重复设置`);
      }

      const result = await page.evaluate(async ({ action, deadline }) => {
        const form = document.querySelector('.issue-due-form');
        const fd = new FormData();
        fd.set('deadline', deadline);
        const resp = await fetch(form.action, {
          method: 'POST',
          body: fd,
          credentials: 'include',
          headers: { 'x-gitea-fetch-action': '1' },
        });
        const ct = resp.headers.get('content-type') || '';
        return { status: resp.status, isJson: ct.includes('application/json'), body: (await resp.text()).slice(0, 200) };
      }, { action: 'due', deadline: clear ? '' : raw });

      if (!result.isJson || result.status >= 400) {
        throw new CommandExecutionError(
          `设置截止日期失败: HTTP ${result.status}（${result.body}）。请确认登录态是否有效`,
        );
      }

      await new Promise((r) => setTimeout(r, 1500));
      try {
        await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-check-${attempt}`, { waitUntil: 'load', timeout: 15000 });
      } catch {
        continue;
      }
      const after = await readDue();
      if (after) {
        const ok = clear ? after.isUnset : (!after.isUnset && after.current === raw);
        if (ok) {
          return {
            issueNumber: issue,
            deadline: clear ? '(cleared)' : raw,
            url: `${BASE}/${repo}/issues/${issue}`,
          };
        }
      }
    }

    throw new CommandExecutionError(
      `截止日期设置未生效（重试 ${maxAttempts} 次后仍不符）。请到页面确认`,
    );
  },
});
