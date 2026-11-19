// 在 Gitea 工单下发表评论——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, commentIssue, requireInt, requireRepo } from './rest.js';

cli({
  site: 'gitea',
  name: 'issue-comment',
  description: '在 Gitea 工单下发表评论（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'body', type: 'string', required: true, positional: true, help: '评论正文（Markdown）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'commentId', 'url'],
  func: command('issue-comment', async (args) => {
    const repo = requireRepo(args.repo);
    const body = String(args.body ?? '').trim();
    if (!body) throw new ArgumentError('评论正文不能为空');
    return commentIssue(repo, requireInt(args.issue, 'issue'), body);
  }),
});
