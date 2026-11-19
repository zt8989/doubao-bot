// Gitea 工单搜索/列表——REST API（令牌见 ~/.foreman/gitea-token），不再解析列表页 HTML。
// labels 既收标签名也收 id（api.mjs 会把 id 翻成名字再按 id 精确过滤），行为与 gitea CLI 一致。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, listIssues, pageOf, requireRepo } from './rest.js';

const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'search',
  description: '搜索/列出 Gitea 仓库工单（REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'query', type: 'string', positional: true, default: '', help: '关键词，命中标题/正文/编号；省略则列出全部' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '工单状态' },
    { name: 'label', type: 'string', default: '', help: '按标签过滤，名称或 id，逗号分隔多个' },
    { name: 'assignee', type: 'string', default: '', help: '按指派人过滤，用户名；none=未指派，any=已有指派' },
    { name: 'milestone', type: 'string', default: '', help: '按里程碑过滤，名称或 id；none=无里程碑' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['number', 'state', 'title', 'labels', 'assignees', 'creator', 'createdAt'],
  func: command('search', async (args) => {
    const repo = requireRepo(args.repo);
    const list = await listIssues(repo, {
      q: String(args.query ?? '').trim(),
      state: String(args.state ?? 'open'),
      labels: String(args.label ?? ''),
      assignee: String(args.assignee ?? ''),
      milestone: String(args.milestone ?? ''),
      page: pageOf(args.page),
    });
    return list.map((issue) => ({ ...issue, creator: issue.author ?? null }));
  }),
});
