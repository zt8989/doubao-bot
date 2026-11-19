// 在 Gitea 仓库创建工单——REST API。附件图片先上传再追加进正文。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, createIssue, editIssue, rejectProject, requireRepo, resolveMilestoneId, splitList, uploadIssueAssets } from './rest.js';

cli({
  site: 'gitea',
  name: 'issue',
  description: '在 Gitea 仓库创建工单（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'title', type: 'string', required: true, help: '工单标题' },
    { name: 'body', type: 'string', default: '', help: '工单正文（Markdown）' },
    { name: 'image', type: 'string', default: '', help: '附件图片，本地路径，逗号分隔多个；上传后随工单提交' },
    { name: 'assignee', type: 'string', default: '', help: '指派人，用户名，逗号分隔多个' },
    { name: 'milestone', type: 'string', default: '', help: '里程碑，名称或 id' },
    { name: 'label', type: 'string', default: '', help: '标签，名称或 id，逗号分隔多个' },
    { name: 'project', type: 'string', default: '', help: '（REST 版本暂不支持）项目，名称或 id' },
    { name: 'ref', type: 'string', default: '', help: '引用分支 / Git 标签，如 main' },
  ],
  columns: ['issueNumber', 'title', 'url'],
  func: command('issue', async (args) => {
    const repo = requireRepo(args.repo);
    rejectProject(args.project);
    const title = String(args.title ?? '').trim();
    if (!title) throw new ArgumentError('缺少 --title');

    const created = await createIssue(repo, {
      title,
      body: String(args.body ?? ''),
      labels: splitList(args.label),
      assignees: splitList(args.assignee),
      milestone: String(args.milestone ?? '').trim() ? await resolveMilestoneId(repo, args.milestone) : null,
      ref: String(args.ref ?? '').trim(),
    });

    const images = splitList(args.image);
    if (images.length) {
      const uploaded = await uploadIssueAssets(repo, created.number, images);
      const md = uploaded.map((u) => `![${u.name}](${u.url})`).join('\n');
      const body = [String(args.body ?? '').trim(), md].filter(Boolean).join('\n\n');
      await editIssue(repo, created.number, { body });
    }

    return {
      issueNumber: created.number,
      title: created.title,
      url: created.url,
      labels: created.labels,
      assignees: created.assignees,
    };
  }),
});
