// Gitea 新建里程碑——复用浏览器登录态，重放 /milestones/new 表单 AJAX。
// 表单字段 title/deadline(YYYY-MM-DD)/content；该表单非 form-fetch-action，但带
// x-gitea-fetch-action 头提交仍返回 JSON {redirect}。创建后回列表页验证并取回 id。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

cli({
  site: 'gitea',
  name: 'milestone-create',
  description: '在 Gitea 仓库新建里程碑（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'title', type: 'string', required: true, positional: true, help: '里程碑标题' },
    { name: 'due', type: 'string', default: '', help: '截止日期 YYYY-MM-DD，可省略' },
    { name: 'description', type: 'string', default: '', help: '描述（Markdown）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['id', 'title', 'due', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const title = String(args.title ?? '').trim();
    if (!title) throw new ArgumentError('title 不能为空');
    const due = String(args.due ?? '').trim();
    if (due) {
      if (!DATE_RE.test(due)) throw new ArgumentError(`due 必须是 YYYY-MM-DD，当前: "${due}"`);
      const d = new Date(`${due}T00:00:00`);
      if (Number.isNaN(d.getTime())) throw new ArgumentError(`due 不是有效日期: "${due}"`);
    }
    const description = String(args.description ?? '');

    const newUrl = `${BASE}/${repo}/milestones/new`;
    try {
      await page.goto(newUrl, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开 ${newUrl} 失败: ${error?.message || error}`);
    }

    const state = await page.evaluate(() => ({
      url: window.location.href,
      hasForm: !!document.querySelector('form[action$="/milestones/new"]'),
    }));
    if (!state.hasForm || /\/user\/login/.test(state.url)) {
      throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    }

    const result = await page.evaluate(async ({ repo, title, due, description }) => {
      const resp = await fetch(`/${repo}/milestones/new`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-gitea-fetch-action': '1' },
        body: new URLSearchParams({ title, deadline: due, content: description }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { error: 'NOT_JSON', status: resp.status };
      const data = await resp.json();
      return { status: resp.status, redirect: data.redirect || null, errorMessage: data.errorMessage || null };
    }, { repo, title, due, description });

    if (result.errorMessage || result.status >= 400) {
      throw new CommandExecutionError(
        `创建里程碑失败: HTTP ${result.status}${result.errorMessage ? `（${result.errorMessage}）` : ''}`,
      );
    }
    if (!result.redirect) {
      throw new CommandExecutionError(`创建里程碑失败: HTTP ${result.status}${result.error ? ` (${result.error})` : ''}，请确认登录态是否有效`);
    }

    // 回列表页验证存在并取回 id
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await page.goto(`${BASE}/${repo}/milestones?state=all&_=${Date.now()}`, { waitUntil: 'load', timeout: 15000 });
    } catch {
      // 验证失败不回滚（里程碑已创建），直接返回
      return { id: null, title, due: due || null, url: `${BASE}${result.redirect}` };
    }
    const found = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('.milestone-list > .item')]
        .find((r) => r.querySelector('.list-item-large-title a')?.textContent.trim() === name);
      const link = row?.querySelector('.list-item-large-title a[href*="/milestone/"]');
      return link ? Number(/\/milestone\/(\d+)/.exec(link.getAttribute('href'))?.[1]) || null : null;
    }, title);

    return {
      id: found,
      title,
      due: due || null,
      url: found ? `${BASE}/${repo}/milestone/${found}` : `${BASE}${result.redirect}`,
    };
  },
});
