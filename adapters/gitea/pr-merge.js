// 合并 Gitea 合并请求——REST API（POST /pulls/{n}/merge，提交后回读确认）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, mergePull, requireInt, requireRepo } from './rest.js';

const STYLES = ['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'];

cli({
  site: 'gitea',
  name: 'pr-merge',
  description: '合并 Gitea 合并请求（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'pr', type: 'int', required: true, positional: true, help: '合并请求编号，如 1' },
    { name: 'style', type: 'string', default: 'merge', choices: STYLES, help: '合并方式' },
    { name: 'title', type: 'string', default: '', help: '合并提交标题，留空用页面默认' },
    { name: 'message', type: 'string', default: '', help: '合并提交扩展描述' },
    { name: 'delete-branch', type: 'bool', default: false, help: '合并后删除来源分支' },
    { name: 'force', type: 'bool', default: false, help: '忽略冲突检查强制合并' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['prNumber', 'state', 'style', 'url'],
  func: command('pr-merge', async (args) => {
    const repo = requireRepo(args.repo);
    const result = await mergePull(repo, requireInt(args.pr, 'pr'), {
      style: String(args.style ?? 'merge'),
      title: String(args.title ?? ''),
      message: String(args.message ?? ''),
      deleteBranch: Boolean(args['delete-branch']),
      force: Boolean(args.force),
    });
    return { prNumber: result.prNumber, state: result.state, style: result.style, url: result.url };
  }),
});
