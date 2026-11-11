// Gitea 按工单创建分支——复用浏览器登录态。
// 命名惯例 issue-{n}-{slug}（与仓库既有 issue-38-pagination 等一致）；
// base 缺省取仓库默认分支（首页 HTML default-branch 属性）；
// 创建走 POST /branches/_new/branch/{base}（FormData{new_branch_name}，成功返回 200 HTML 非 JSON）；
// 该实例写操作偶发静默 no-op 且 Chrome 缓存重，创建后必须延迟 + no-store 复查分支列表确认。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { openIssuePage } from './utils.js';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

// 标题 → ASCII slug；中文标题产出为空时分支名退化为纯 issue-{n}
const slugify = (title) => String(title).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
cli({
  site: 'gitea',
  name: 'branch',
  description: '按 Gitea 工单创建分支 issue-{n}-{slug}（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'issue', type: 'int', required: true, positional: true, help: '工单编号，如 34' },
    { name: 'name', type: 'string', positional: true, default: '', help: '分支短名；缺省取工单标题 ASCII slug，中文标题（无 ASCII 词）时为纯 issue-{n}' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'base', type: 'string', default: '', help: '起点分支；缺省用仓库默认分支' },
  ],
  columns: ['branch', 'base', 'issueNumber', 'issueTitle', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const issue = Number(args.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ArgumentError(`issue 必须是正整数，当前: "${args.issue}"`);
    }

    // 读工单标题（openIssuePage 已校验登录态与工单存在性）
    await openIssuePage(page, repo, issue, 'branch');
    const issueTitle = await page.evaluate((n) => {
      const el = document.querySelector('#issue-title-rendered') || document.querySelector('.issue-title h1, h1');
      return (el?.textContent || '').replace(/\s+/g, ' ').trim().replace(new RegExp(`#\\s*${n}\\s*$`), '').trim();
    }, issue);
    if (!issueTitle) throw new CommandExecutionError(`工单 ${repo}#${issue} 页面未取到标题`);

    const short = String(args.name ?? '').trim();
    const slug = short || slugify(issueTitle);
    const prefix = `issue-${issue}`;
    const branch = slug.startsWith(`${prefix}-`) ? slug : (slug ? `${prefix}-${slug}` : prefix);
    if (!/^[\w.\-/]+$/.test(branch) || branch.startsWith('.') || branch.endsWith('/') || branch.endsWith('.lock')) {
      throw new ArgumentError(`分支名不合法: "${branch}"（仅允许字母/数字/-._/，不以 . 开头）`);
    }

    // 前检查：分支已存在时 Gitea 对创建请求仍返回 200 不报错，必须先查列表拦截；
    // 注：分支列表页有分页，分支数超过页容量时前检查会漏（当前仓库分支数远未到）
    const branchEsc = escapeRe(branch);
    const branchInList = async (tag) => {
      const r = await page.evaluate(async ({ listUrl, branchEsc }) => {
        const resp = await fetch(listUrl, { credentials: 'include', cache: 'no-store' });
        const t = await resp.text();
        return { status: resp.status, found: new RegExp('src/branch/' + branchEsc + '["\'/]').test(t) };
      }, { listUrl: `${BASE}/${repo}/branches?_=${Date.now()}-${tag}`, branchEsc });
      if (r.status === 401 || r.status === 403) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
      return r.found;
    };
    if (await branchInList('pre')) {
      throw new ArgumentError(`分支 "${branch}" 已存在: ${BASE}/${repo}/src/branch/${branch}`);
    }

    let base = String(args.base ?? '').trim();
    if (!base) {
      try {
        await page.goto(`${BASE}/${repo}?_=${Date.now()}-defbranch`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开仓库首页失败: ${error?.message || error}`);
      }
      base = await page.evaluate(() =>
        /default[_-]branch=["']([\w.\-/]+)["']/.exec(document.documentElement.outerHTML)?.[1] || null);
      if (!base) throw new CommandExecutionError('无法从仓库首页确定默认分支，请显式传 --base');
    }

    const create = await page.evaluate(async ({ url, branch }) => {
      const fd = new FormData();
      fd.append('new_branch_name', branch);
      const resp = await fetch(url, { method: 'POST', body: fd, credentials: 'include' });
      const ct = resp.headers.get('content-type') || '';
      const text = await resp.text();
      return { status: resp.status, ct, isJson: ct.includes('application/json'), errorMessage: /"errorMessage":"([^"]*)"/.exec(text)?.[1] || null };
    }, { url: `${BASE}/${repo}/branches/_new/branch/${encodeURIComponent(base)}`, branch });

    if (create.status === 401 || create.status === 403) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    if (create.errorMessage) {
      throw new CommandExecutionError(`创建分支失败: ${create.errorMessage}（base=${base}，请确认起点分支存在）`);
    }
    if (create.status !== 200) {
      throw new CommandExecutionError(`创建分支失败: HTTP ${create.status}（base=${base}）`);
    }
    // 200 仅代表受理；该实例偶发静默 no-op，必须复查分支列表确认
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await branchInList('verify'))) {
      throw new CommandExecutionError(
        `创建请求已受理（HTTP 200）但复查分支列表未见 "${branch}"（疑似服务端静默 no-op），请到 ${BASE}/${repo}/branches 确认后重试`,
      );
    }

    return {
      branch,
      base,
      issueNumber: issue,
      issueTitle,
      url: `${BASE}/${repo}/src/branch/${branch}`,
    };
  },
});
