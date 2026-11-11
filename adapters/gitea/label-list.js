// Gitea 标签列表——复用浏览器登录态，解析标签页 HTML（无需 API token）。
// 仓库标签页同时列出"仓库级"与"组织级"两段：组织级行带 .org-label 类，名称/颜色/描述
// 都在 .label-title .ui.label；id 在 .label-issues 链接的 labels=<id> 里（组织页/仓库页通用）。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'label-list',
  description: '列出 Gitea 仓库或组织标签（复用 Chrome 已登录会话）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'repo', type: 'string', default: '', help: '仓库，owner/name 格式（含组织级标签）' },
    { name: 'org', type: 'string', default: '', help: '组织名，只列组织级标签' },
  ],
  columns: ['id', 'scope', 'name', 'color', 'description', 'issuesCount'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    const org = String(args.org || '').replace(/^\/+|\/+$/g, '');
    if (!repo && !org) throw new ArgumentError('repo 和 org 至少提供一个');
    if (repo && org) throw new ArgumentError('repo 和 org 只能提供一个（仓库页已包含组织级标签）');
    if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }

    const url = repo ? `${BASE}/${repo}/labels` : `${BASE}/org/${org}/settings/labels`;
    try {
      await page.goto(`${url}?_=${Date.now()}`, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开 ${url} 失败: ${error?.message || error}`);
    }

    const pageState = await page.evaluate(() => ({ url: window.location.href, hasList: !!document.querySelector('.issue-label-list') }));
    if (/\/user\/login/.test(pageState.url)) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    if (!pageState.hasList) {
      throw new CommandExecutionError(`${repo ? `仓库 ${repo}` : `组织 ${org}`} 无标签页或无权访问`);
    }

    return page.evaluate((isOrg) => [...document.querySelectorAll('.issue-label-list > li.item')]
      .filter((li) => li.querySelector('.label-title'))
      .map((li) => {
        const labelEl = li.querySelector('.label-title .ui.label');
        const editBtn = li.querySelector('.edit-label-button');
        const href = li.querySelector('.label-issues a')?.getAttribute('href') || '';
        return {
          id: Number(editBtn?.getAttribute('data-label-id') || /labels=(\d+)/.exec(href)?.[1]) || null,
          scope: isOrg || li.classList.contains('org-label') ? 'org' : 'repo',
          name: labelEl?.querySelector('.gt-ellipsis')?.textContent.trim() || labelEl?.textContent.trim() || null,
          color: editBtn?.getAttribute('data-label-color')
            || /background-color:\s*([^;!]+)/.exec(labelEl?.getAttribute('style') || '')?.[1]?.trim() || null,
          description: editBtn?.getAttribute('data-label-description')
            || labelEl?.getAttribute('title') || null,
          issuesCount: Number(/(\d+)\s*个开启中/.exec(li.querySelector('.label-issues')?.textContent || '')?.[1]) || 0,
        };
      }), !repo);
  },
});
