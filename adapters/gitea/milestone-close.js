// 关闭/重开 Gitea 里程碑——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, milestoneUrl, requireRepo, resolveMilestoneId, setMilestoneState } from './rest.js';

cli({
  site: 'gitea',
  name: 'milestone-close',
  description: '关闭/重开 Gitea 里程碑（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'milestone', type: 'string', required: true, positional: true, help: '里程碑名称或 id' },
    { name: 'reopen', type: 'bool', default: false, help: '重新开启（默认是关闭）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['id', 'milestone', 'state', 'url'],
  func: command('milestone-close', async (args) => {
    const repo = requireRepo(args.repo);
    const id = await resolveMilestoneId(repo, args.milestone);
    const result = await setMilestoneState(repo, id, args.reopen ? 'open' : 'closed');
    return { id: result.id, milestone: result.name, state: result.state, url: milestoneUrl(repo, result.id) };
  }),
});
