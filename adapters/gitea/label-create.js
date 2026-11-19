// 在 Gitea 仓库或组织新建标签——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, createLabel } from './rest.js';

const DEFAULT_COLOR = '#ededed';

cli({
  site: 'gitea',
  name: 'label-create',
  description: '在 Gitea 仓库或组织新建标签（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'name', type: 'string', required: true, positional: true, help: '标签名称，如 needs-triage' },
    { name: 'color', type: 'string', default: DEFAULT_COLOR, help: '颜色 #rrggbb，默认 #ededed' },
    { name: 'description', type: 'string', default: '', help: '描述，可省略' },
    { name: 'repo', type: 'string', default: '', help: '仓库，owner/name 格式' },
    { name: 'org', type: 'string', default: '', help: '组织名（创建组织级标签，组织下所有仓库可用）' },
  ],
  columns: ['id', 'scope', 'name', 'color', 'description', 'url'],
  func: command('label-create', async (args) => {
    const name = String(args.name ?? '').trim();
    if (!name) throw new ArgumentError('name 不能为空');
    return createLabel({
      name,
      color: String(args.color ?? DEFAULT_COLOR),
      description: String(args.description ?? ''),
      repo: String(args.repo ?? '').trim(),
      org: String(args.org ?? '').trim(),
    });
  }),
});
