// Gitea 合并合并请求——复用浏览器登录态（无需 API token）。
// PR 页合并面板是 Vue 组件（data-global-init=initRepoPullMergeBox）：点样式主按钮渲染确认表单，
// 非默认合并方式需先点样式下拉项；选择样式会触发 Vue 重渲染，交互后必须重新查询 DOM。
// 表单 POST /pulls/{n}/merge，字段含 head_commit_id/force_merge/do，do 由 button[name=do] 的 value
// 承载，手动提交需显式 set('do', style)。响应同创建：JSON {redirect}。
// 状态判断用 .issue-state-label（已合并/已关闭），合并面板缺失时（分支已删除等）不误判。
// 该实例写操作偶发静默 no-op，合并后带 cache-buster 复查状态并重试。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';
const STYLES = ['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'];
// 样式下拉项与主按钮文案（实例中文界面 + Gitea 英文兜底），提交前用 do 按钮的 value 复核
const STYLE_LABELS = {
  merge: ['创建合并提交', 'Create a merge commit'],
  rebase: ['变基后快进', 'Rebase then fast-forward'],
  'rebase-merge': ['变基后创建合并提交', 'Rebase then create a merge commit'],
  squash: ['创建压缩提交', 'Squash and merge'],
  'fast-forward-only': ['仅快进', 'Fast-forward only'],
};
// 精确匹配优先，防止误点同区域的其他按钮（如"更新分支"）
const MERGED_RE = /已合并|merged/i;
const CLOSED_RE = /已关闭|closed/i;

cli({
  site: 'gitea',
  name: 'pr-merge',
  description: '合并 Gitea 合并请求（复用 Chrome 已登录会话）',
  access: 'write',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  // 站点只跑 http；显式覆盖 core 由 domain 推导出的 https:// 前置导航
  navigateBefore: BASE,
  args: [
    { name: 'pr', type: 'int', required: true, positional: true, help: '合并请求编号，如 1' },
    { name: 'style', type: 'string', default: 'merge', choices: STYLES, help: '合并方式' },
    { name: 'title', type: 'string', default: '', help: '合并提交标题，留空用页面默认' },
    { name: 'message', type: 'string', default: '', help: '合并提交扩展描述' },
    { name: 'delete-branch', type: 'bool', default: false, help: '合并后删除来源分支' },
    { name: 'force', type: 'bool', default: false, help: '忽略冲突检查强制合并' },
    { name: 'repo', type: 'string', required: true, help: '仓库，owner/name 格式' },
  ],
  columns: ['prNumber', 'state', 'style', 'url'],
  func: async (page, args) => {
    const repo = String(args.repo || '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
    }
    const pr = Number(args.pr);
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new ArgumentError(`pr 必须是正整数，当前: "${args.pr}"`);
    }
    const style = String(args.style ?? 'merge');
    if (!STYLES.includes(style)) {
      throw new ArgumentError(`style 必须是 ${STYLES.join('/')}，当前: "${style}"`);
    }
    const title = String(args.title ?? '').trim();
    const message = String(args.message ?? '');
    const delBranch = Boolean(args['delete-branch']);
    const force = Boolean(args.force);
    const prUrl = `${BASE}/${repo}/pulls/${pr}`;

    const readState = () =>
      page.evaluate(() => {
        const box = document.querySelector('.pull-merge-box');
        return {
          url: window.location.href,
          stateLabel: document.querySelector('.issue-state-label')?.textContent.trim() || null,
          hasBox: !!box,
          boxText: box?.textContent.trim().replace(/\s+/g, ' ').slice(0, 200) || null,
        };
      });

    // 等待页面/合并面板渲染完成（合并面板由 Vue 异步挂载）
    const readStateSettled = async ({ timeoutMs = 6000 } = {}) => {
      const start = Date.now();
      let state = null;
      while (Date.now() - start < timeoutMs) {
        state = await readState();
        if (/\/user\/login/.test(state.url)) return state;
        if (state.stateLabel || state.hasBox) return state;
        await new Promise((r) => setTimeout(r, 300));
      }
      return state;
    };

    const maxAttempts = 3;
    let lastState = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const bust = `?_=${Date.now()}-${attempt}`;
      try {
        await page.goto(`${prUrl}${bust}`, { waitUntil: 'load', timeout: 15000 });
      } catch (error) {
        throw new CommandExecutionError(`打开合并请求页失败: ${error?.message || error}`);
      }
      lastState = await readStateSettled();
      if (/\/user\/login/.test(lastState.url)) {
        throw new CommandExecutionError(`无法访问合并请求 ${repo}#${pr}：请确认登录态有效`);
      }
      if (lastState.stateLabel && MERGED_RE.test(lastState.stateLabel)) {
        throw new EmptyResultError(`gitea pr-merge ${repo}#${pr}`, '合并请求已合并，无需重复合并');
      }
      if (lastState.stateLabel && CLOSED_RE.test(lastState.stateLabel)) {
        throw new CommandExecutionError(`合并请求 ${repo}#${pr} 已关闭，无法合并（请先 gitea reopen）`);
      }
      if (!lastState.hasBox) {
        throw new CommandExecutionError(
          `合并请求 ${repo}#${pr} 页面没有合并区域：请确认编号存在且有合并权限`,
        );
      }

      const result = await page.evaluate(async ({ style, styleLabels, title, message, delBranch, force }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const findStyleButton = () =>
          [...document.querySelectorAll('.pull-merge-box button')]
            .filter((b) => !b.closest('.ui.dropdown') && !b.classList.contains('merge-cancel'))
            .find((b) => {
              const text = b.textContent.trim();
              return styleLabels.some((l) => text === l) ||
                styleLabels.some((l) => text.includes(l) && text.length <= l.length + 10);
            });

        if (style !== 'merge') {
          const dropdown = document.querySelector('.pull-merge-box .ui.dropdown');
          if (!dropdown) return { error: 'NO_DROPDOWN' };
          dropdown.click();
          await sleep(500);
          const items = [...document.querySelectorAll('.pull-merge-box .menu > .item')];
          const wanted = styleLabels.find((label) => items.find((it) => it.textContent.trim().includes(label)));
          const item = wanted && items.find((it) => it.textContent.trim().includes(wanted));
          if (!item) {
            return { error: 'NO_STYLE_ITEM', items: items.map((it) => it.textContent.trim()).join(', ') };
          }
          item.click();
          await sleep(700);
        }

        // 选择样式会触发 Vue 重渲染，必须重新查询；只点样式按钮，避免误点"更新分支"等
        const primary = findStyleButton();
        if (!primary) return { error: 'NO_STYLE_BUTTON', boxText: document.querySelector('.pull-merge-box')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 150) };
        primary.click();
        await sleep(800);

        const form = document.querySelector('.pull-merge-box form');
        if (!form) return { error: 'NO_FORM' };
        const doValue = form.querySelector('button[name=do]')?.value || null;
        if (doValue !== style) {
          return { error: 'DO_MISMATCH', doValue };
        }
        if (title) form.querySelector('input[name=merge_title_field]').value = title;
        if (message) form.querySelector('textarea[name=merge_message_field]').value = message;

        const fd = new FormData(form);
        fd.set('do', style);
        if (force) fd.set('force_merge', 'true');
        if (delBranch) fd.set('delete_branch_after_merge', 'on');
        const resp = await fetch(form.action, {
          method: 'POST',
          body: fd,
          credentials: 'include',
          headers: { 'x-gitea-fetch-action': '1' },
        });
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          return { error: 'NOT_JSON', status: resp.status };
        }
        const data = await resp.json();
        return { status: resp.status, redirect: data.redirect || null, errorMessage: data.errorMessage || null };
      }, { style, styleLabels: STYLE_LABELS[style], title, message, delBranch, force });

      if (result.error === 'NO_DROPDOWN' || result.error === 'NO_STYLE_ITEM' || result.error === 'NO_STYLE_BUTTON') {
        const detail = result.error === 'NO_STYLE_ITEM'
          ? `可选项: ${result.items}`
          : result.error === 'NO_STYLE_BUTTON' ? `页面: ${result.boxText}` : '页面没有样式下拉';
        throw new CommandExecutionError(`合并方式 ${style} 在页面上不可用（${detail}）`);
      }
      if (result.error === 'NO_FORM') {
        throw new CommandExecutionError('页面未渲染合并确认表单，请确认有合并权限');
      }
      if (result.error === 'DO_MISMATCH') {
        throw new CommandExecutionError(`页面 do=${result.doValue} 与请求的 ${style} 不符，已取消提交`);
      }
      if (result.status === 401 || result.status === 403) {
        throw new CommandExecutionError(`合并失败: HTTP ${result.status}，请确认登录态与合并权限`);
      }
      if (result.errorMessage) {
        throw new CommandExecutionError(`合并失败: ${result.errorMessage}`);
      }
      if (!result.redirect) {
        throw new CommandExecutionError(
          `合并失败: HTTP ${result.status}${result.error ? ` (${result.error})` : ''}，请确认登录态是否有效`,
        );
      }

      // 等服务端落库后，带新 cache-buster 复查；若服务端 no-op 则重试
      await new Promise((r) => setTimeout(r, 1500));
      const bust2 = `?_=${Date.now()}-check-${attempt}`;
      try {
        await page.goto(`${prUrl}${bust2}`, { waitUntil: 'load', timeout: 15000 });
      } catch {
        continue;
      }
      lastState = await readStateSettled();
      if (lastState.stateLabel && MERGED_RE.test(lastState.stateLabel)) {
        return {
          prNumber: pr,
          state: 'merged',
          style,
          deleteBranch: delBranch,
          url: prUrl,
        };
      }
      if (lastState.stateLabel && CLOSED_RE.test(lastState.stateLabel)) {
        throw new CommandExecutionError(`合并请求 ${repo}#${pr} 在合并后被关闭，请到页面确认`);
      }
    }

    throw new CommandExecutionError(
      `合并未生效（重试 ${maxAttempts} 次后仍未合并，页面状态: ${lastState?.stateLabel}）。请到页面确认: ${prUrl}`,
    );
  },
});
