// Gitea 工单指派——复用浏览器登录态（无需 API token），验证与重试见 utils.js。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { updateAssignee } from './utils.js';

const HOST = '106.54.199.229:3000';
const BASE = 'http://106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'assign',
  description: '指派/取消指派 Gitea 工单（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'user', type: 'string', required: true, positional: true, help: '用户名或用户 id' },
    { name: 'remove', type: 'bool', default: false, help: '取消指派' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'action', 'assignees', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }
    const user = String(args.user ?? '').trim();
    if (!user) throw new ArgumentError('user 不能为空');
    return updateAssignee(page, repo, issue, user, Boolean(args.remove));
  },
});
