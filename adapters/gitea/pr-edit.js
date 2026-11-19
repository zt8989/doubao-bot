// 编辑 Gitea 合并请求标题/正文——REST API。无差异不算失败（changed:false，退出码 0）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, editPull, requireInt, requireRepo, viewPull } from './rest.js';

cli({
  site: 'gitea',
  name: 'pr-edit',
  description: '编辑 Gitea 合并请求标题/正文（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'pr', type: 'int', required: true, positional: true, help: '合并请求编号，如 1' },
    { name: 'title', type: 'string', default: '', help: '新标题，省略则不修改' },
    { name: 'body', type: 'string', default: '', help: '新正文（Markdown），省略则不修改' },
    { name: 'append', type: 'bool', default: false, help: '把 body 追加到现有正文末尾（如补 Closes #N 关联工单）' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['prNumber', 'title', 'bodyChanged', 'changed', 'url'],
  func: command('pr-edit', async (args) => {
    const repo = requireRepo(args.repo);
    const prNumber = requireInt(args.pr, 'pr');
    const title = String(args.title ?? '').trim();
    const bodyRaw = String(args.body ?? '');
    if (!title && !bodyRaw) throw new ArgumentError('--title 和 --body 至少提供一个');
    if (args.append && !bodyRaw) throw new ArgumentError('--append 需要配合 --body');

    const current = await viewPull(repo, prNumber, { files: false });
    let body = bodyRaw;
    if (args.append && bodyRaw) {
      body = [String(current.body ?? '').replace(/\s+$/, ''), bodyRaw].filter(Boolean).join('\n\n');
    }

    const patch = {};
    if (title && title !== current.title) patch.title = title;
    if (body && body !== String(current.body ?? '')) patch.body = body;
    const changed = Object.keys(patch).length > 0;
    if (changed) await editPull(repo, prNumber, patch);

    return {
      prNumber,
      title: patch.title ?? current.title,
      bodyChanged: Boolean(patch.body),
      changed,
      url: current.url,
    };
  }),
});
