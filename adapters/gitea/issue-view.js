// 查看 Gitea 工单详情与评论——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, requireInt, requireRepo, viewIssue } from './rest.js';

cli({
  site: 'gitea',
  name: 'issue-view',
  description: '查看 Gitea 工单详情与评论（REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['number', 'state', 'title', 'author', 'assignees', 'milestone', 'comments', 'url'],
  func: command('issue-view', async (args) => {
    const repo = requireRepo(args.repo);
    const issue = await viewIssue(repo, requireInt(args.issue, 'issue'), { withComments: true });
    return {
      number: issue.number,
      state: issue.state,
      title: issue.title,
      author: issue.author,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      body: issue.body,
      bodyMd: issue.bodyMd,
      labels: issue.labels,
      labelObjects: issue.labelObjects,
      assignees: issue.assignees,
      milestone: issue.milestone,
      dueDate: issue.dueDate,
      commentsCount: issue.commentsCount,
      comments: issue.comments ?? [],
      projects: issue.projects ?? [],
      url: issue.url,
    };
  }),
});
