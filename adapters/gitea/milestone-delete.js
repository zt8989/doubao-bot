// 删除 Gitea 仓库里程碑（工单上的该里程碑标记会被一并清除）——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, deleteMilestone, requireRepo, resolveMilestoneId } from './rest.js';

cli({
  site: 'gitea',
  name: 'milestone-delete',
  description: '删除 Gitea 仓库里程碑（工单上的该里程碑标记会被一并清除，REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'milestone', type: 'string', required: true, positional: true, help: '里程碑名称或 id' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['id', 'milestone', 'deleted'],
  func: command('milestone-delete', async (args) => {
    const repo = requireRepo(args.repo);
    const wanted = String(args.milestone ?? '').trim();
    const id = await resolveMilestoneId(repo, wanted);
    await deleteMilestone(repo, id);
    return { id, milestone: wanted, deleted: true };
  }),
});
