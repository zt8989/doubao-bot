// 关闭 Gitea 工单——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, requireInt, requireRepo, setIssueState } from './rest.js';

cli({
  site: 'gitea',
  name: 'close',
  description: '关闭 Gitea 工单（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'state', 'url'],
  func: command('close', async (args) => {
    const repo = requireRepo(args.repo);
    return setIssueState(repo, requireInt(args.issue, 'issue'), 'closed');
  }),
});
