// gitea 站点共享逻辑：工单状态切换（close/reopen）与工单页侧栏读取。
// 经验：Chrome 对工单详情页有启发式缓存，刷新需带 cache-buster；
// 服务端偶发对状态变更请求 no-op（返回 200 但无事件），必须验证最终状态并重试。
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

const BASE = 'http://106.54.199.229:3000';
const HOST = '106.54.199.229:3000';

// 目标操作 -> 操作成功后 status-button 的 value（按钮永远提供“反向”操作）
const SUCCESS_BTN = { close: 'reopen', reopen: 'close' };

// 指派/取消指派（Gitea 28 sidebar combo diff 算法：POST update-url，action=attach/detach&id=<uid>）
export async function updateAssignee(page, repo, issue, userName, remove, { maxAttempts = 3 } = {}) {
  const readCombo = async () =>
    page.evaluate(() => {
      const combo = document.querySelector('.issue-sidebar-combo[data-update-url*="assignee"]');
      if (!combo) return null;
      const items = [...combo.querySelectorAll('.ui.dropdown .menu > .item[data-value]')].map((el) => ({
        id: el.getAttribute('data-value'),
        name: el.querySelector('img')?.getAttribute('title') || el.textContent.trim(),
        checked: el.classList.contains('checked'),
      }));
      return { updateUrl: combo.getAttribute('data-update-url'), items };
    });

  let target = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-${attempt}`, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开工单页失败: ${error?.message || error}`);
    }
    const state = await readCombo();
    if (!state) {
      throw new CommandExecutionError(`页面 ${repo}#${issue} 未找到指派人侧栏，请确认登录态有效、工单存在`);
    }
    target = state.items.find((it) => it.name === userName || it.id === userName);
    if (!target) {
      throw new CommandExecutionError(
        `仓库 ${repo} 中找不到可指派用户 "${userName}"，可用: ${state.items.map((i) => i.name).join(', ')}`,
      );
    }

    const wantChecked = !remove;
    if (target.checked === wantChecked) {
      throw new EmptyResultError(
        `gitea assign ${repo}#${issue}`,
        remove ? `用户 ${target.name} 未被指派，无需取消` : `用户 ${target.name} 已被指派，无需重复指派`,
      );
    }

    const result = await page.evaluate(async ({ updateUrl, action, id }) => {
      const resp = await fetch(updateUrl, {
        method: 'POST',
        body: new URLSearchParams({ action, id }),
        credentials: 'include',
        headers: { 'x-gitea-fetch-action': '1' },
      });
      const ct = resp.headers.get('content-type') || '';
      return { status: resp.status, isJson: ct.includes('application/json'), body: (await resp.text()).slice(0, 200) };
    }, { updateUrl: state.updateUrl, action: remove ? 'detach' : 'attach', id: target.id });

    if (!result.isJson || result.status >= 400) {
      throw new CommandExecutionError(
        `指派操作失败: HTTP ${result.status}（${result.body}）。请确认登录态是否有效`,
      );
    }

    await new Promise((r) => setTimeout(r, 1500));
    try {
      await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-check-${attempt}`, { waitUntil: 'load', timeout: 15000 });
    } catch {
      continue;
    }
    const check = await readCombo();
    const after = check?.items.find((it) => it.id === target.id);
    if (after && after.checked === wantChecked) {
      const assignees = check.items.filter((it) => it.checked).map((it) => it.name).join(', ');
      return {
        issueNumber: issue,
        action: remove ? 'unassigned' : 'assigned',
        assignees: assignees || '(none)',
        url: `${BASE}/${repo}/issues/${issue}`,
      };
    }
  }

  throw new CommandExecutionError(
    `指派变更未生效（重试 ${maxAttempts} 次后仍不符）。请到页面确认`,
  );
}

export async function changeIssueStatus(page, repo, issue, action, { maxAttempts = 3 } = {}) {
  const readState = async () =>
    page.evaluate(() => ({
      url: window.location.href,
      hasForm: !!document.querySelector('form#comment-form'),
      btnValue: document.querySelector('#status-button')?.value || null,
    }));

  let lastState = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const bust = `?_=${Date.now()}-${attempt}`;
    try {
      await page.goto(`${BASE}/${repo}/issues/${issue}${bust}`, { waitUntil: 'load', timeout: 15000 });
    } catch (error) {
      throw new CommandExecutionError(`打开工单页失败: ${error?.message || error}`);
    }
    lastState = await readState();
    if (!lastState.hasForm || lastState.btnValue === null || /\/user\/login/.test(lastState.url)) {
      throw new CommandExecutionError(
        `无法访问工单 ${repo}#${issue}：请确认登录态有效、工单编号存在`,
      );
    }

    if (lastState.btnValue === SUCCESS_BTN[action]) {
      throw new EmptyResultError(
        `gitea ${action} ${repo}#${issue}`,
        action === 'close' ? '工单已经是关闭状态，无需重复关闭' : '工单已经是开启状态，无需重新开启',
      );
    }

    const result = await page.evaluate(async ({ status }) => {
      const form = document.querySelector('form#comment-form');
      const fd = new FormData(form);
      fd.set('status', status);
      const resp = await fetch(form.action, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        headers: { 'x-gitea-fetch-action': '1' },
      });
      const ct = resp.headers.get('content-type') || '';
      const bodyText = await resp.text();
      return { status: resp.status, isJson: ct.includes('application/json'), body: bodyText.slice(0, 200) };
    }, { status: action });

    if (!result.isJson || result.status >= 400) {
      throw new CommandExecutionError(
        `切换工单状态失败: HTTP ${result.status}（${result.body}）。请确认登录态是否有效`,
      );
    }

    // 等服务端落库后，带新 cache-buster 复查；若服务端 no-op 则重试
    await new Promise((r) => setTimeout(r, 1500));
    const bust2 = `?_=${Date.now()}-check-${attempt}`;
    try {
      await page.goto(`${BASE}/${repo}/issues/${issue}${bust2}`, { waitUntil: 'load', timeout: 15000 });
    } catch {
      // 复查导航失败留给下一轮
      continue;
    }
    lastState = await readState();
    if (lastState.btnValue === SUCCESS_BTN[action]) {
      return {
        issueNumber: issue,
        state: action === 'close' ? 'closed' : 'open',
        url: `${BASE}/${repo}/issues/${issue}`,
      };
    }
  }

  throw new CommandExecutionError(
    `${action} ${repo}#${issue} 未生效（重试 ${maxAttempts} 次后按钮状态仍不符，最后: ${lastState?.btnValue}）。请到页面确认`,
  );
}

// 正文比对用的归一化：只抹平换行风格、行尾空白、连续空行、NBSP/零宽字符与 Markdown 反斜杠转义，
// 这些差异不代表"没写进去"，不应把已生效的写入判成失败；真实文字差异一律保留。
export function canonicalBody(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\ufeff]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, '$1')
    .trim();
}

// 两份正文是否只差"归一化"层面（换行/空白/转义）
export function bodyEquivalent(a, b) {
  return canonicalBody(a) === canonicalBody(b);
}

// 报错时用：给出首个差异所在的片段，而不是只让调用方"到页面确认"
export function bodyDiff(submitted, actual, context = 2) {
  const toLines = (s) => String(s ?? '').replace(/\r\n?/g, '\n').split('\n');
  const left = toLines(submitted);
  const right = toLines(actual);
  let i = 0;
  while (i < left.length && i < right.length && left[i] === right[i]) i++;
  const from = Math.max(0, i - context);
  const seg = (lines) => lines.slice(from, Math.min(lines.length, i + context + 1)).join('\n').slice(0, 400);
  return `首个差异在第 ${i + 1} 行（提交 ${left.length} 行 / 回读 ${right.length} 行）：提交片段 ${JSON.stringify(seg(left))}；回读片段 ${JSON.stringify(seg(right))}`;
}

// 打开工单页并校验登录态；Chrome 对工单页有启发式缓存，统一带 cache-buster。
export async function openIssuePage(page, repo, issue, tag = 'open') {
  try {
    await page.goto(`${BASE}/${repo}/issues/${issue}?_=${Date.now()}-${tag}`, { waitUntil: 'load', timeout: 15000 });
  } catch (error) {
    throw new CommandExecutionError(`打开工单页失败: ${error?.message || error}`);
  }
  const state = await page.evaluate(() => ({
    url: window.location.href,
    hasContent: !!document.querySelector('.issue-content-comment'),
    hasForm: !!document.querySelector('form#comment-form'),
  }));
  if (/\/user\/login/.test(state.url)) {
    throw new AuthRequiredError(HOST, undefined, `Gitea 站点是 ${BASE}（http，无 https）；请在该地址的 Chrome 登录态下重试`);
  }
  if (!state.hasContent) {
    throw new CommandExecutionError(`无法访问工单 ${repo}#${issue}：请确认工单编号存在、登录态有效`);
  }
  return state;
}

// 读侧栏 combo：data-update-url 已带内部 issue id（与显示编号不同），标签/指派 diff 提交都靠它；
// 标签项名称在 .gt-ellipsis，指派项名称在头像 img[title]，里程碑当前值在 combo-value（0 表示未设置）。
export async function readIssueSidebar(page) {
  return page.evaluate(() => {
    const combo = (name) => [...document.querySelectorAll('.issue-sidebar-combo')]
      .find((c) => c.querySelector('.combo-value')?.name === name);
    const readListCombo = (name) => {
      const el = combo(name);
      if (!el) return null;
      return {
        updateUrl: el.getAttribute('data-update-url'),
        value: String(el.querySelector('.combo-value')?.value ?? ''),
        items: [...el.querySelectorAll('.ui.dropdown .menu > .item[data-value]')].map((it) => ({
          id: it.getAttribute('data-value'),
          name: it.querySelector('.gt-ellipsis')?.textContent.trim()
            || it.querySelector('img')?.getAttribute('title')
            || it.textContent.trim(),
          checked: it.classList.contains('checked'),
        })),
      };
    };
    const milestoneEl = combo('milestone_id');
    return {
      labels: readListCombo('label_ids'),
      assignees: readListCombo('assignee_ids'),
      milestone: {
        updateUrl: milestoneEl?.getAttribute('data-update-url') || null,
        value: String(milestoneEl?.querySelector('.combo-value')?.value ?? ''),
        name: [...(milestoneEl?.querySelectorAll('.ui.list .item:not(.empty-list)') || [])]
          .map((it) => it.textContent.trim())
          .filter(Boolean)
          .join(', ') || null,
      },
    };
  });
}
