// Gitea 工单指派——REST API（PATCH assignees），不再走页面下拉。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, requireInt, requireRepo, setAssignees } from './rest.js';

cli({
  site: 'gitea',
  name: 'assign',
  description: '指派/取消指派 Gitea 工单（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'user', type: 'string', required: true, positional: true, help: '用户名' },
    { name: 'remove', type: 'bool', default: false, help: '取消指派' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'action', 'assignees', 'url'],
  func: command('assign', async (args) => {
    const repo = requireRepo(args.repo);
    const user = String(args.user ?? '').trim();
    if (!user) throw new ArgumentError('user 不能为空');
    const issueNumber = requireInt(args.issue, 'issue');
    return setAssignees(repo, issueNumber, Boolean(args.remove) ? { remove: [user] } : { add: [user] });
  }),
});
