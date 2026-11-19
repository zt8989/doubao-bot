// 列出 Gitea 仓库或组织标签——REST API（仓库视角会合并组织级标签）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { command, listLabels } from './rest.js';

cli({
  site: 'gitea',
  name: 'label-list',
  description: '列出 Gitea 仓库或组织标签（REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'repo', type: 'string', default: '', help: '仓库，owner/name 格式（含组织级标签）' },
    { name: 'org', type: 'string', default: '', help: '组织名，只列组织级标签' },
  ],
  columns: ['id', 'scope', 'name', 'color', 'description', 'issuesCount'],
  func: command('label-list', async (args) => listLabels({
    repo: String(args.repo ?? '').trim(),
    org: String(args.org ?? '').trim(),
  })),
});
