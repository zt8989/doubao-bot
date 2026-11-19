// 在 Gitea 仓库创建合并请求——REST API。附件图片先上传再追加进正文。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, createPull, editPull, rejectProject, requireRepo, resolveMilestoneId, splitList, uploadIssueAssets } from './rest.js';

cli({
  site: 'gitea',
  name: 'pr',
  description: '在 Gitea 仓库创建合并请求（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'base', type: 'string', required: true, help: '目标分支（合并到）' },
    { name: 'head', type: 'string', required: true, help: '来源分支（变更来自）' },
    { name: 'title', type: 'string', required: true, help: '合并请求标题' },
    { name: 'body', type: 'string', default: '', help: '描述（Markdown）' },
    { name: 'image', type: 'string', default: '', help: '附件图片，本地路径，逗号分隔多个；上传后随创建提交' },
    { name: 'assignee', type: 'string', default: '', help: '指派人，用户名，逗号分隔多个' },
    { name: 'milestone', type: 'string', default: '', help: '里程碑，名称或 id' },
    { name: 'label', type: 'string', default: '', help: '标签，名称或 id，逗号分隔多个' },
    { name: 'project', type: 'string', default: '', help: '（REST 版本暂不支持）项目，名称或 id' },
    { name: 'reviewer', type: 'string', default: '', help: '评审人，用户名，逗号分隔多个' },
    { name: 'draft', type: 'bool', default: false, help: '创建为草稿（标题自动加 WIP: 前缀）' },
  ],
  columns: ['prNumber', 'title', 'base', 'head', 'url'],
  func: command('pr', async (args) => {
    const repo = requireRepo(args.repo);
    rejectProject(args.project);
    const title = String(args.title ?? '').trim();
    if (!title) throw new ArgumentError('缺少 --title');
    const base = String(args.base ?? '').trim();
    const head = String(args.head ?? '').trim();
    if (!base || !head) throw new ArgumentError('--base 与 --head 都不能为空');

    const created = await createPull(repo, {
      base,
      head,
      title,
      body: String(args.body ?? ''),
      labels: splitList(args.label),
      assignees: splitList(args.assignee),
      milestone: String(args.milestone ?? '').trim() ? await resolveMilestoneId(repo, args.milestone) : null,
      reviewers: splitList(args.reviewer),
      draft: Boolean(args.draft),
    });

    const images = splitList(args.image);
    if (images.length) {
      const uploaded = await uploadIssueAssets(repo, created.number, images);
      const md = uploaded.map((u) => `![${u.name}](${u.url})`).join('\n');
      const body = [String(args.body ?? '').trim(), md].filter(Boolean).join('\n\n');
      await editPull(repo, created.number, { body });
    }

    return { prNumber: created.prNumber, number: created.number, title: created.title, base, head, url: created.url };
  }),
});
