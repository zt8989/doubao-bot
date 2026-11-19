// 设置/清除工单或合并请求的里程碑——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, requireInt, requireRepo, setIssueMilestone } from './rest.js';

cli({
  site: 'gitea',
  name: 'milestone-set',
  description: '设置/清除工单或合并请求的里程碑（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单或合并请求编号，如 1' },
    { name: 'milestone', type: 'string', positional: true, help: '里程碑名称或 id；--remove 时省略' },
    { name: 'remove', type: 'bool', default: false, help: '清除里程碑' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'action', 'milestone', 'url'],
  func: command('milestone-set', async (args) => {
    const repo = requireRepo(args.repo);
    const remove = Boolean(args.remove);
    const wanted = String(args.milestone ?? '').trim();
    if (!remove && !wanted) throw new ArgumentError('milestone 不能为空（或使用 --remove 清除）');
    if (remove && wanted) throw new ArgumentError('--remove 与 milestone 不能同时提供');
    const result = await setIssueMilestone(repo, requireInt(args.issue, 'issue'), wanted, { remove });
    return {
      issueNumber: result.issueNumber,
      action: result.action,
      milestone: result.milestone?.name ?? null,
      milestoneId: result.milestone?.id ?? null,
      url: result.url,
    };
  }),
});
