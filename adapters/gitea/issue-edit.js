// 编辑 Gitea 工单标题/正文/标签——REST API。无差异不算失败（changed:false，退出码 0）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, editIssue, editIssueLabels, requireInt, requireRepo, splitList, viewIssue } from './rest.js';

cli({
  site: 'gitea',
  name: 'issue-edit',
  description: '编辑 Gitea 工单标题/正文/标签（REST API）',
  access: 'write',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'title', type: 'string', default: '', help: '新标题，省略则不修改' },
    { name: 'body', type: 'string', default: '', help: '新正文（Markdown），省略则不修改' },
    { name: 'append', type: 'bool', default: false, help: '把 body 追加到现有正文末尾' },
    { name: 'label-add', type: 'string', default: '', help: '要添加的标签，名称或 id，逗号分隔多个' },
    { name: 'label-remove', type: 'string', default: '', help: '要移除的标签，名称或 id，逗号分隔多个' },
    { name: 'set-labels', type: 'string', default: '', help: '全量设置标签（替换现有集合），名称或 id，逗号分隔；与 add/remove 互斥' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'title', 'labels', 'bodyChanged', 'changed', 'url'],
  func: command('issue-edit', async (args) => {
    const repo = requireRepo(args.repo);
    const issueNumber = requireInt(args.issue, 'issue');
    const title = String(args.title ?? '').trim();
    const bodyRaw = String(args.body ?? '');
    const append = Boolean(args.append);
    const add = splitList(args['label-add']);
    const remove = splitList(args['label-remove']);
    const set = splitList(args['set-labels']);

    if (!title && !bodyRaw && !add.length && !remove.length && !set.length) {
      throw new ArgumentError('至少提供 --title、--body、--label-add、--label-remove、--set-labels 之一');
    }
    if (append && !bodyRaw) throw new ArgumentError('--append 需要配合 --body');
    if (set.length && (add.length || remove.length)) {
      throw new ArgumentError('--set-labels 与 label-add/label-remove 不能同时使用');
    }

    const current = await viewIssue(repo, issueNumber, { withComments: false });
    let body = bodyRaw;
    if (append && bodyRaw) {
      body = [String(current.body ?? '').replace(/\s+$/, ''), bodyRaw].filter(Boolean).join('\n\n');
    }

    const patch = {};
    if (title && title !== current.title) patch.title = title;
    if (body && body !== String(current.body ?? '')) patch.body = body;
    const wroteBody = Boolean(patch.body);
    if (Object.keys(patch).length) await editIssue(repo, issueNumber, patch);

    let changed = Object.keys(patch).length > 0;
    let labels = current.labelObjects;
    if (set.length || add.length || remove.length) {
      const result = await editIssueLabels(repo, issueNumber, { add, remove, set });
      labels = result.labels;
      changed = changed || Boolean(result.changed);
    }

    return {
      issueNumber,
      title: patch.title ?? current.title,
      labels,
      bodyChanged: wroteBody,
      changed,
      url: current.url,
    };
  }),
});
