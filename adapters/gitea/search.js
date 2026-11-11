// Gitea 工单搜索/列表——复用浏览器登录态，解析工单列表页 HTML。
// 经验：该实例 API 强制 token（session cookie 访问 /api/v1 返回 401），走不通；
// 列表页每页条数由实例配置决定，翻页用 page 参数；type=issues 排除合并请求。
// 指派/里程碑过滤只认数字 id：用户名、里程碑名的映射来自筛选下拉的链接文案，先解析再重载列表。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'search',
  description: '搜索/列出 Gitea 仓库工单（复用 Chrome 已登录会话）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'query', type: 'string', positional: true, default: '', help: '关键词，命中标题/正文/编号；省略则列出全部' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '工单状态' },
    { name: 'label', type: 'string', default: '', help: '按标签 id 过滤，逗号分隔多个' },
    { name: 'assignee', type: 'string', default: '', help: '按指派人过滤，用户名或 id；none=未指派，any=已有指派' },
    { name: 'milestone', type: 'string', default: '', help: '按里程碑过滤，名称或 id；none=无里程碑' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['number', 'state', 'title', 'labels', 'assignees', 'creator', 'createdAt'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const query = String(args.query ?? '').trim();
    const labelIds = String(args.label ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const pageNum = Number(args.page) || 1;
    if (!Number.isInteger(pageNum) || pageNum <= 0) throw new ArgumentError(`page 必须是正整数，当前: "${args.page}"`);
    const assigneeArg = String(args.assignee ?? '').trim();
    const milestoneArg = String(args.milestone ?? '').trim();

    const url = new URL(`${BASE}/${repo}/issues`);
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('type', 'issues');
    url.searchParams.set('state', args.state);
    if (labelIds.length) url.searchParams.set('labels', labelIds.join(','));
    if (pageNum > 1) url.searchParams.set('page', String(pageNum));

    const gotoList = async (target) => {
      try {
        await page.goto(target.href, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开 ${target.href} 失败: ${error?.message || error}`);
      }
      const pageState = await page.evaluate(() => ({
        url: window.location.href,
        isList: !!document.querySelector('.page-content.repository.issue-list'),
        notFound: /Page Not Found/i.test(document.title),
      }));
      if (pageState.notFound) {
        // 404 不是登录态问题：仓库名大小写写错也会落到这里，别再误报 AUTH_REQUIRED
        throw new CommandExecutionError(`仓库或路径不存在（404）：${repo}（Gitea 仓库名区分大小写）`);
      }
      if (!pageState.isList || /\/user\/login/.test(pageState.url)) {
        throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
      }
    };

    if (assigneeArg || milestoneArg) {
      await gotoList(url);
      const resolved = await page.evaluate(({ assignee, milestone }) => {
        const links = [...document.querySelectorAll('a[href*="assignee="], a[href*="milestone="]')].map((a) => ({
          text: a.textContent.replace(/\s+/g, ' ').trim(),
          href: a.getAttribute('href') || '',
        }));
        const norm = (s) => s.replace(/[()]/g, '').trim().toLowerCase();
        const idOf = (href, param) => new RegExp(`${param}=([^&]+)`).exec(href)?.[1] || null;
        const find = (param, value) => {
          const v = value.trim();
          const hit = links.find((l) => l.href.includes(`${param}=`) && norm(l.text) === v.toLowerCase());
          if (hit) return idOf(hit.href, param);
          if (param === 'assignee' && /^(none|any)$/i.test(v)) return `(${v.toLowerCase()})`;
          if (param === 'milestone' && /^none$/i.test(v)) return '-1';
          if (/^\d+$/.test(v)) return v;
          return null;
        };
        return {
          assigneeId: assignee ? find('assignee', assignee) : null,
          milestoneId: milestone ? find('milestone', milestone) : null,
          users: links
            .filter((l) => /assignee=/.test(l.href) && !/assignee=(%28(none|any)%29|\(none\)|\(any\))/.test(l.href))
            .map((l) => l.text),
          milestones: links.filter((l) => l.href.includes('milestone=') && !/milestone=-1/.test(l.href)).map((l) => l.text),
        };
      }, { assignee: assigneeArg, milestone: milestoneArg });

      if (assigneeArg && !resolved.assigneeId) {
        throw new CommandExecutionError(
          `找不到指派人 "${assigneeArg}"，可选: ${resolved.users.join(', ') || '（无）'}`,
        );
      }
      if (milestoneArg && !resolved.milestoneId) {
        throw new CommandExecutionError(
          `找不到里程碑 "${milestoneArg}"，可选: ${resolved.milestones.join(', ') || '（仓库还没有里程碑）'}`,
        );
      }
      if (resolved.assigneeId) url.searchParams.set('assignee', resolved.assigneeId);
      if (resolved.milestoneId) url.searchParams.set('milestone', resolved.milestoneId);
      url.searchParams.set('_', String(Date.now()));
      await gotoList(url);
    } else {
      url.searchParams.set('_', String(Date.now()));
      await gotoList(url);
    }

    return page.evaluate(() => {
      const rows = [...document.querySelectorAll('a.list-item-large-title')]
        .map((a) => a.closest('.item'))
        .filter(Boolean);
      return rows.map((row) => {
        const titleLink = row.querySelector('a.list-item-large-title');
        return {
          number: Number((row.querySelector('a.index')?.textContent || '').replace(/\D/g, '')) || null,
          state: row.querySelector('.octicon-issue-opened') ? 'open'
            : row.querySelector('.octicon-issue-closed') ? 'closed' : null,
          title: titleLink.textContent.trim(),
          url: new URL(titleLink.getAttribute('href'), window.location.origin).href,
          labels: [...row.querySelectorAll('.labels-list .ui-label')]
            .map((l) => l.getAttribute('data-tooltip-content') || l.textContent.trim()),
          assignees: [...row.querySelectorAll('img.avatar[title]')].map((i) => i.getAttribute('title')),
          creator: row.querySelector('.item-body a[href^="/"]:not(.index)')?.textContent.trim() || null,
          createdAt: row.querySelector('relative-time')?.getAttribute('datetime') || null,
        };
      });
    });
  },
});
