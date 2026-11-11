// Gitea 新建标签——复用浏览器登录态，重放标签弹窗表单 AJAX（无需 API token）。
// 仓库级 POST /{repo}/labels/new，组织级 POST /org/{org}/settings/labels/new（可被组织下所有仓库使用）；
// 表单字段 id/title/description/color，color 传 #rrggbb，返回 {redirect}；创建后回列表页验证并取回 id。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const DEFAULT_COLOR = '#ededed';

// 接受 #rrggbb / rrggbb / #rgb，统一成 #rrggbb
const normalizeColor = (raw) => {
  const s = String(raw ?? '').trim();
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
};

cli({
  site: 'gitea',
  name: 'label-create',
  description: '在 Gitea 仓库或组织新建标签（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'name', type: 'string', required: true, positional: true, help: '标签名称，如 needs-triage' },
    { name: 'color', type: 'string', default: DEFAULT_COLOR, help: '颜色 #rrggbb，默认 #ededed' },
    { name: 'description', type: 'string', default: '', help: '描述，可省略' },
    { name: 'repo', type: 'string', default: '', help: '仓库，owner/name 格式' },
    { name: 'org', type: 'string', default: '', help: '组织名（创建组织级标签，组织下所有仓库可用）' },
  ],
  columns: ['id', 'scope', 'name', 'color', 'description', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    const org = String(args.org || '').replace(/^\/+|\/+$/g, '');
    if (!repo && !org) throw new ArgumentError('repo 和 org 至少提供一个');
    if (repo && org) throw new ArgumentError('repo 和 org 只能提供一个');
    if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const name = String(args.name ?? '').trim();
    if (!name) throw new ArgumentError('name 不能为空');
    if (name.length > 50) throw new ArgumentError(`标签名称最长 50 字符，当前 ${name.length}`);
    const color = normalizeColor(args.color ?? DEFAULT_COLOR);
    if (!color) throw new ArgumentError(`color 必须是 #rrggbb 形式的十六进制颜色，当前: "${args.color}"`);
    const description = String(args.description ?? '');

    const listUrl = repo ? `${BASE}/${repo}/labels` : `${BASE}/org/${org}/settings/labels`;
    const createUrl = repo ? `/${repo}/labels/new` : `/org/${org}/settings/labels/new`;

    const readRows = () => page.evaluate(() => [...document.querySelectorAll('.issue-label-list > li.item')]
      .filter((li) => li.querySelector('.label-title'))
      .map((li) => ({
        id: Number(li.querySelector('.edit-label-button')?.getAttribute('data-label-id')) || null,
        name: li.querySelector('.label-title .ui.label')?.querySelector('.gt-ellipsis')?.textContent.trim() || null,
      })));

    const openList = async (tag) => {
      try {
        await page.goto(`${listUrl}?_=${Date.now()}-${tag}`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开 ${listUrl} 失败: ${error?.message || error}`);
      }
      const state = await page.evaluate(() => ({ url: window.location.href, hasList: !!document.querySelector('.issue-label-list') }));
      if (/\/user\/login/.test(state.url)) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
      if (!state.hasList) throw new CommandExecutionError(`${repo ? `仓库 ${repo}` : `组织 ${org}`} 无标签页或无权访问`);
    };

    await openList('pre');
    const existing = (await readRows()).find((r) => r.name === name);
    if (existing) {
      throw new EmptyResultError(
        `gitea label-create ${name}`,
        `标签 "${name}" 已存在（id=${existing.id}，${repo ? `仓库 ${repo}` : `组织 ${org}`}）`,
      );
    }

    const result = await page.evaluate(async ({ createUrl, name, color, description }) => {
      const resp = await fetch(createUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-gitea-fetch-action': '1' },
        body: new URLSearchParams({ id: '', title: name, description, color }),
      });
      const ct = resp.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
      return { status: resp.status, redirect: data?.redirect || null, errorMessage: data?.errorMessage || null };
    }, { createUrl, name, color, description });

    if (result.status === 401 || result.status === 403) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
    if (!result.redirect) {
      throw new CommandExecutionError(
        `创建标签失败: HTTP ${result.status}${result.errorMessage ? `（${result.errorMessage}）` : ''}，请确认登录态与权限`,
      );
    }

    await new Promise((r) => setTimeout(r, 800));
    await openList('verify');
    const created = (await readRows()).find((r) => r.name === name);
    if (!created) {
      throw new CommandExecutionError(`标签已提交创建，但刷新列表后找不到 "${name}"，请到 ${listUrl} 确认`);
    }

    return {
      id: created.id,
      scope: repo ? 'repo' : 'org',
      name,
      color,
      description,
      url: listUrl,
    };
  },
});
