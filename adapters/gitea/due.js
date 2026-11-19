// 设置/清除 Gitea 工单截止日期——REST API（POST /issues/{n}/deadline）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, requireInt, requireRepo, setDueDate } from './rest.js';

cli({
  site: 'gitea',
  name: 'due',
  description: '设置/清除 Gitea 工单截止日期（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'date', type: 'string', required: true, positional: true, help: '截止日期 YYYY-MM-DD，或 clear 清除' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'deadline', 'url'],
  func: command('due', async (args) => {
    const repo = requireRepo(args.repo);
    const date = String(args.date ?? '').trim();
    if (!date) throw new ArgumentError('date 必须是 YYYY-MM-DD 或 clear');
    if (!/^(clear|\d{4}-\d{2}-\d{2})$/i.test(date)) throw new ArgumentError(`date 必须是 YYYY-MM-DD 或 clear，当前: "${date}"`);
    return setDueDate(repo, requireInt(args.issue, 'issue'), date);
  }),
});
