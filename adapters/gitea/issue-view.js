// Gitea 查看工单详情——复用浏览器登录态，解析工单详情页（无需 API token）。
// 该实例 /api/v1 强制 token，页面 HTML 是唯一数据源：
// 正文是首条 timeline（.issue-content-comment），评论是后续 .timeline-item.comment；
// 状态用图标类判断（octicon-issue-opened/closed，不依赖中英文文案）；
// 正文文本取 .comment-body innerText（渲染后文本，Markdown 语法已转成格式）；
// 原文取同容器内 .raw-content 隐藏节点（服务端直出的原始 Markdown，完整无截断），比对格式只认它。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { openIssuePage } from './utils.js';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'issue-view',
  description: '查看 Gitea 工单详情与评论（复用 Chrome 已登录会话）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['number', 'state', 'title', 'author', 'assignees', 'milestone', 'comments', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }

    await openIssuePage(page, repo, issue);

    const detail = await page.evaluate((issue) => {
      const stateEl = document.querySelector('.issue-state-label');
      const state = stateEl?.querySelector('.octicon-git-merge') ? 'merged'
        : stateEl?.querySelector('.octicon-issue-closed') ? 'closed'
          : stateEl?.querySelector('.octicon-issue-opened') ? 'open'
            : null;

      // 标题 h1 带 "#<编号>" 后缀，去掉后与搜索/建单返回的 title 对齐
      const titleEl = document.querySelector('#issue-title-rendered') || document.querySelector('.issue-title h1, h1');
      const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(new RegExp(`#\\s*${issue}\\s*$`), '').trim();

      const bodyEl = document.querySelector('.issue-content-comment');
      const labelsCombo = [...document.querySelectorAll('.issue-sidebar-combo')]
        .find((c) => c.querySelector('.combo-value')?.name === 'label_ids');
      const assigneeCombo = [...document.querySelectorAll('.issue-sidebar-combo')]
        .find((c) => c.querySelector('.combo-value')?.name === 'assignee_ids');
      const milestoneCombo = [...document.querySelectorAll('.issue-sidebar-combo')]
        .find((c) => c.querySelector('.combo-value')?.name === 'milestone_id');

      const labels = [...document.querySelectorAll('.ui.list.labels-list a.item')].map((a) => {
        const labelEl = a.querySelector('.ui.label');
        return {
          id: Number(/labels=(\d+)/.exec(a.getAttribute('href') || '')?.[1]) || null,
          name: labelEl?.querySelector('.gt-ellipsis')?.textContent.trim() || labelEl?.textContent.trim() || null,
          color: /background-color:\s*([^;!]+)/.exec(labelEl?.getAttribute('style') || '')?.[1]?.trim() || null,
          description: labelEl?.getAttribute('title') || null,
        };
      });

      const milestoneValue = String(milestoneCombo?.querySelector('.combo-value')?.value ?? '');
      const milestoneName = [...(milestoneCombo?.querySelectorAll('.ui.list .item:not(.empty-list)') || [])]
        .map((it) => it.textContent.trim()).filter(Boolean).join(', ') || null;
      const milestone = milestoneName && milestoneValue !== '0' && milestoneValue !== ''
        ? { id: Number(milestoneValue) || null, name: milestoneName }
        : null;

      const comments = [...document.querySelectorAll('.timeline-item.comment')]
        .filter((it) => !it.classList.contains('issue-content-comment') && !it.classList.contains('form'))
        .map((it) => ({
          id: Number(/#?issuecomment-(\d+)/.exec(it.id)?.[1]) || null,
          author: it.querySelector('.comment-header .tw-font-semibold')?.textContent.trim() || null,
          authoredAt: it.querySelector('relative-time')?.getAttribute('datetime') || null,
          body: it.querySelector('.comment-body')?.innerText.trim() || '',
          bodyMd: it.querySelector('.raw-content')?.textContent.trim() ?? null,
        }));

      return {
        number: issue,
        title,
        state,
        author: bodyEl?.querySelector('.comment-header .tw-font-semibold')?.textContent.trim() || null,
        createdAt: bodyEl?.querySelector('relative-time')?.getAttribute('datetime') || null,
        body: bodyEl?.querySelector('.comment-body')?.innerText.trim() || '',
        bodyMd: bodyEl?.querySelector('.raw-content')?.textContent.trim() ?? null,
        labels,
        assignees: [...(assigneeCombo?.querySelectorAll('.ui.list .item img[title]') || [])]
          .map((img) => img.getAttribute('title')),
        milestone,
        comments,
      };
    }, issue);

    return { ...detail, url: `${BASE}/${repo}/issues/${issue}` };
  },
});
