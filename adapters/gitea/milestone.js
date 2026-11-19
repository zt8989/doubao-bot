// 列出 Gitea 仓库里程碑——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, listMilestones, milestoneUrl, pageOf, requireRepo } from './rest.js';

const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'milestone',
  description: '列出 Gitea 仓库里程碑（REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'query', type: 'string', positional: true, default: '', help: '关键词，命中里程碑标题；省略则列出全部' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '里程碑状态' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['id', 'name', 'state', 'percent', 'openCount', 'closedCount', 'due', 'url'],
  func: command('milestone', async (args) => {
    const repo = requireRepo(args.repo);
    const state = String(args.state ?? 'open');
    const list = await listMilestones(repo, {
      state,
      query: String(args.query ?? '').trim(),
      page: pageOf(args.page),
      all: state === 'all',
    });
    return list.map((m) => ({ ...m, url: milestoneUrl(repo, m.id) }));
  }),
});
