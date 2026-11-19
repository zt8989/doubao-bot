// 按 Gitea 工单创建分支 issue-{n}-{slug}——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, createIssueBranch, requireInt, requireRepo } from './rest.js';

cli({
  site: 'gitea',
  name: 'branch',
  description: '按 Gitea 工单创建分支 issue-{n}-{slug}（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 34' },
    { name: 'name', type: 'string', positional: true, default: '', help: '分支短名；缺省取工单标题 ASCII slug，中文标题（无 ASCII 词）时为纯 issue-{n}' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'base', type: 'string', default: '', help: '起点分支；缺省用仓库默认分支' },
  ],
  columns: ['branch', 'base', 'issueNumber', 'issueTitle', 'url'],
  func: command('branch', async (args) => {
    const repo = requireRepo(args.repo);
    return createIssueBranch(repo, requireInt(args.issue, 'issue'), {
      name: String(args.name ?? '').trim(),
      base: String(args.base ?? '').trim(),
    });
  }),
});
