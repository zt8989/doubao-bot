// 在 Gitea 仓库新建里程碑——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, createMilestone, milestoneUrl, requireRepo } from './rest.js';

cli({
  site: 'gitea',
  name: 'milestone-create',
  description: '在 Gitea 仓库新建里程碑（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'title', type: 'string', required: true, positional: true, help: '里程碑标题' },
    { name: 'due', type: 'string', default: '', help: '截止日期 YYYY-MM-DD，可省略' },
    { name: 'description', type: 'string', default: '', help: '描述（Markdown）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['id', 'title', 'due', 'url'],
  func: command('milestone-create', async (args) => {
    const repo = requireRepo(args.repo);
    const title = String(args.title ?? '').trim();
    if (!title) throw new ArgumentError('title 不能为空');
    const created = await createMilestone(repo, {
      title,
      due: String(args.due ?? '').trim(),
      description: String(args.description ?? ''),
    });
    return { id: created.id, title: created.title, due: created.due, url: milestoneUrl(repo, created.id) };
  }),
});
