// 查看 Gitea 合并请求状态与变更文件——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, requireInt, requireRepo, viewPull } from './rest.js';

cli({
  site: 'gitea',
  name: 'pr-view',
  description: '查看 Gitea 合并请求状态与变更文件（REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'pr', type: 'int', required: true, positional: true, help: '合并请求编号，如 1' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'files', type: 'bool', default: false, help: '同时列出变更文件与增删行数' },
  ],
  columns: ['number', 'state', 'title', 'head', 'base', 'commits', 'filesCount', 'comments'],
  func: command('pr-view', async (args) => {
    const repo = requireRepo(args.repo);
    const pull = await viewPull(repo, requireInt(args.pr, 'pr'), { files: Boolean(args.files) });
    return {
      number: pull.number,
      state: pull.state,
      title: pull.title,
      author: pull.author,
      head: pull.head,
      base: pull.base,
      commits: pull.commits,
      filesCount: pull.filesCount,
      additions: pull.additions,
      deletions: pull.deletions,
      mergeable: pull.mergeable,
      mergeNote: pull.mergeNote,
      draft: pull.draft,
      createdAt: pull.createdAt,
      mergedAt: pull.mergedAt,
      body: pull.body,
      bodyMd: pull.bodyMd,
      labels: pull.labels,
      assignees: pull.assignees,
      comments: pull.comments ?? [],
      files: pull.files ?? [],
      url: pull.url,
    };
  }),
});
