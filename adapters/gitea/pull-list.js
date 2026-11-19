// 列出 Gitea 仓库的合并请求——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, listPulls, pageOf, requireRepo } from './rest.js';

const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'pull-list',
  description: '列出 Gitea 仓库的合并请求（REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '合并请求状态' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['number', 'state', 'title', 'author', 'head', 'base', 'createdAt', 'updatedAt', 'url'],
  func: command('pull-list', async (args) => {
    const repo = requireRepo(args.repo);
    return listPulls(repo, { state: String(args.state ?? 'open'), page: pageOf(args.page) });
  }),
});
