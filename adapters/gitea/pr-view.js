// Gitea 查看合并请求——复用浏览器登录态，解析 PR 页 HTML（无需 API token）。
// 状态用 .issue-state-label 的图标类判断（octicon-git-merge=已合并、issue-closed=已关闭），
// 分支在 .pull-desc 的 <code> 里按 [head, base] 顺序出现；提交/文件数来自页签文案；
// --files 时再开 /pulls/{n}/files，用 .diff-file-box 的 data-new-filename 与增删行统计；
// body 为渲染文本，原文（原始 Markdown）在 bodyMd（.raw-content 隐藏节点），比对格式只认它。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

cli({
  site: 'gitea',
  name: 'pr-view',
  description: '查看 Gitea 合并请求状态与变更文件（复用 Chrome 已登录会话）',
  access: 'read',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'pr', type: 'int', required: true, positional: true, help: '合并请求编号，如 1' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
    { name: 'files', type: 'bool', default: false, help: '同时列出变更文件与增删行数' },
  ],
  columns: ['number', 'state', 'title', 'head', 'base', 'commits', 'filesCount', 'comments'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const pr = Number(args.pr);
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new ArgumentError(`pr 必须是正整数，当前: "${args.pr}"`);
    }
    const wantFiles = Boolean(args.files);

    const openPage = async (path, tag) => {
      const url = `${BASE}/${repo}/${path}?_=${Date.now()}-${tag}`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开 ${url} 失败: ${error?.message || error}`);
      }
      const state = await page.evaluate(() => ({
        url: window.location.href,
        hasContent: !!document.querySelector('.issue-content-comment, .diff-file-box'),
      }));
      if (/\/user\/login/.test(state.url)) throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
      if (!state.hasContent) {
        throw new CommandExecutionError(`无法访问合并请求 ${repo}#${pr}：请确认编号存在、登录态有效`);
      }
    };

    await openPage(`pulls/${pr}`, 'view');

    const info = await page.evaluate(({ pr }) => {
      const stateEl = document.querySelector('.issue-state-label');
      const state = stateEl?.querySelector('.octicon-git-merge') ? 'merged'
        : stateEl?.querySelector('.octicon-issue-closed') ? 'closed'
          : stateEl?.querySelector('.octicon-issue-opened') ? 'open'
            : null;

      const titleEl = document.querySelector('#issue-title-rendered') || document.querySelector('.issue-title h1, h1');
      const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(new RegExp(`#\\s*${pr}\\s*$`), '').trim();

      // .pull-desc 的 <code> 依序是 head、base；两处（合并事件 / 合并框）取第一处即可
      const pullDesc = document.querySelector('.pull-desc');
      const branches = pullDesc
        ? [...pullDesc.querySelectorAll('code')].map((c) => c.textContent.trim()).filter(Boolean)
        : [];

      const tabCount = (suffix) => {
        const a = [...document.querySelectorAll(`a[href*="/pulls/${pr}/${suffix}"]`)][0];
        return Number((a?.textContent || '').replace(/[^\d]/g, '')) || null;
      };

      const bodyEl = document.querySelector('.issue-content-comment');
      const comments = [...document.querySelectorAll('.timeline-item.comment')]
        .filter((it) => !it.classList.contains('issue-content-comment') && !it.classList.contains('form')
          && !it.classList.contains('pull-merge-box'))
        .map((it) => ({
          id: Number(/#issuecomment-(\d+)/.exec(it.id)?.[1]) || null,
          author: it.querySelector('.comment-header .tw-font-semibold')?.textContent.trim() || null,
          authoredAt: it.querySelector('relative-time')?.getAttribute('datetime') || null,
          body: it.querySelector('.comment-body')?.innerText.trim() || '',
          bodyMd: it.querySelector('.raw-content')?.textContent.trim() ?? null,
        }));

      const mergeBox = document.querySelector('.pull-merge-box, .merge-section');
      return {
        number: pr,
        title,
        state,
        author: bodyEl?.querySelector('.comment-header .tw-font-semibold')?.textContent.trim() || null,
        createdAt: bodyEl?.querySelector('relative-time')?.getAttribute('datetime') || null,
        head: branches[0] || null,
        base: branches[1] || null,
        commits: tabCount('commits'),
        filesCount: tabCount('files'),
        body: bodyEl?.querySelector('.comment-body')?.innerText.trim() || '',
        bodyMd: bodyEl?.querySelector('.raw-content')?.textContent.trim() ?? null,
        mergeNote: mergeBox?.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) || null,
        comments,
      };
    }, { pr });

    if (wantFiles) {
      await openPage(`pulls/${pr}/files`, 'files');
      info.files = await page.evaluate(() => [...document.querySelectorAll('.diff-file-box')].map((box) => {
        const name = box.getAttribute('data-new-filename') || box.getAttribute('data-old-filename') || '';
        const added = Number((box.querySelector('.tw-text-diff-added-fg')?.textContent || '').replace(/[^\d]/g, '')) || 0;
        const removed = Number((box.querySelector('.tw-text-diff-del-fg')?.textContent || '').replace(/[^\d]/g, '')) || 0;
        return { name, added, removed };
      }));
    }

    info.url = `${BASE}/${repo}/pulls/${pr}`;
    return info;
  },
});
