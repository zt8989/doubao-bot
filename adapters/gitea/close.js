// Gitea 关闭工单——复用浏览器登录态（无需 API token），状态验证与重试见 utils.js。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { changeIssueStatus } from './utils.js';

const HOST = '106.54.199.229:3000';
const BASE = 'http://106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'close',
  description: '关闭 Gitea 工单（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 1' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['issueNumber', 'state', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }
    return changeIssueStatus(page, repo, issue, 'close');
  },
});
