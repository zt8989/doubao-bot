// ==UserScript==
// @name         teleagent 定时发送检查消息
// @namespace    local.teleagent.heartbeat
// @version      1.1.0
// @description  定时向 teleagent 发送一句话（默认5分钟，可自定义），默认内容为检查 win-ai-harness 健康接口
// @match        https://agent.teleai.com.cn/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_MESSAGE = '检查 win-ai-harness http://127.0.0.1:8080/health 是否返回 200';

  // 以下选择器基于 2026-11 实测：输入框是 Slate 编辑器，发送按钮 aria-label=运行，
  // agent 执行期间按钮变为 暂停
  const AREA_SEL = '[data-testid="prompt-input-area"]';
  const EDITOR_SEL = AREA_SEL + ' [contenteditable="true"]';
  const RUN_SEL = AREA_SEL + ' button[aria-label="运行"]';
  const BUSY_SEL = AREA_SEL + ' button[aria-label="暂停"]';

  const cfg = {
    intervalMin: GM_getValue('intervalMin', 5),
    message: GM_getValue('message', DEFAULT_MESSAGE),
    enabled: GM_getValue('enabled', true),
  };

  let remainingSec = cfg.intervalMin * 60;
  let sending = false;
  let panelCollapsed = false;

  function saveCfg() {
    GM_setValue('intervalMin', cfg.intervalMin);
    GM_setValue('message', cfg.message);
    GM_setValue('enabled', cfg.enabled);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isInsideOwnPanel(el) {
    return !!el.closest('[data-teleagent-hb-panel]');
  }

  // ---------- 查找输入框与发送按钮 ----------

  function findInput() {
    const precise = document.querySelector(EDITOR_SEL);
    if (precise && isVisible(precise)) return precise;
    // 兜底：页面结构变化时退回通用查找（textarea / contenteditable / 文本输入框）
    let best = null;
    for (const el of document.querySelectorAll(
      'textarea, [contenteditable="true"], input[type="text"]',
    )) {
      if (el.disabled || el.readOnly || isInsideOwnPanel(el) || !isVisible(el)) continue;
      const score = el.tagName === 'TEXTAREA' ? 3 : el.isContentEditable ? 2 : 1;
      const rect = el.getBoundingClientRect();
      const key = score * 1e7 + rect.bottom;
      if (!best || key > best._hbKey) {
        best = el;
        best._hbKey = key;
      }
    }
    return best;
  }

  function findRunButton() {
    const precise = document.querySelector(RUN_SEL);
    if (precise) return precise;
    // 兜底：通用按钮文本匹配
    let best = null;
    let bestBottom = -1;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (el.disabled || !isVisible(el)) continue;
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent ||
        ''
      ).trim();
      if (/验证码|取消|停止|暂停|清空|上传|附件/.test(label)) continue;
      if (!/^(发送|发送消息|运行|send|run|submit)$/i.test(label)) continue;
      const bottom = el.getBoundingClientRect().bottom;
      if (bottom > bestBottom) {
        best = el;
        bestBottom = bottom;
      }
    }
    return best;
  }

  function isAgentBusy() {
    // agent 回复生成中：运行按钮被替换为 暂停
    return !!document.querySelector(BUSY_SEL);
  }

  // ---------- 写入消息 ----------

  function setInputText(editor, text) {
    editor.focus();
    // Slate 编辑器只响应 beforeinput；原生 setter 用于普通 textarea/input 兜底
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }),
    );
  }

  function setNativeValue(el, text) {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  function getInputText(el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.textContent;
  }

  // ---------- 发送流程 ----------

  async function sendMessage() {
    if (sending) return;
    sending = true;
    let ok = false;
    let waitFull = false;
    try {
      if (isAgentBusy()) {
        log('agent 正在执行，等待空闲后发送');
        return;
      }
      const input = findInput();
      if (!input) {
        log('未找到聊天输入框，30秒后重试');
        return;
      }
      const existing = getInputText(input).trim();
      if (existing && existing !== cfg.message.trim()) {
        log('输入框中有内容，跳过本次发送');
        waitFull = true;
        return;
      }

      if (!existing) {
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          setNativeValue(input, cfg.message);
        } else {
          setInputText(input, cfg.message);
        }
        await sleep(600);
        if (!getInputText(input).trim()) {
          log('消息写入失败，30秒后重试');
          return;
        }
      }

      let btn = findRunButton();
      if (btn && btn.disabled) {
        pressEnter(input);
        await sleep(1500);
        btn = findRunButton();
      }
      if (!btn || btn.disabled) {
        log('发送按钮不可用，30秒后重试');
        return;
      }
      btn.click();
      await sleep(2000);

      const cleared = !getInputText(findInput() || input).trim();
      if (cleared || isAgentBusy()) {
        ok = true;
        log('已发送：' + cfg.message);
      } else {
        log('发送未生效，30秒后重试');
      }
    } finally {
      sending = false;
      remainingSec = ok || waitFull ? cfg.intervalMin * 60 : 30;
      updatePanel();
    }
  }

  // ---------- 倒计时 ----------

  setInterval(() => {
    if (!cfg.enabled || sending) return;
    remainingSec -= 1;
    if (remainingSec <= 0) {
      remainingSec = 0;
      sendMessage();
    }
    updatePanel();
  }, 1000);

  // ---------- 悬浮面板 ----------

  const panel = document.createElement('div');
  panel.dataset.teleagentHbPanel = '1';
  panel.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'width:280px',
    'background:rgba(20,20,28,0.92)',
    'color:#e8e8ee',
    'border-radius:10px',
    'font:12px/1.5 system-ui,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
    'padding:10px 12px',
    'user-select:none',
  ].join(';');

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
      <b style="flex:1">定时发送</b>
      <span data-f="status" style="opacity:0.85"></span>
      <button data-f="toggle" style="all:unset;cursor:pointer;padding:0 4px">—</button>
    </div>
    <div data-f="body">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span>间隔(分)</span>
        <input data-f="interval" type="number" min="0.5" step="0.5"
          style="all:unset;width:56px;background:#33333f;border-radius:4px;padding:2px 6px;text-align:center">
      </div>
      <textarea data-f="message" rows="3"
        style="all:unset;box-sizing:border-box;width:100%;background:#33333f;border-radius:4px;padding:4px 6px;user-select:text;resize:vertical"></textarea>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button data-f="save" style="all:unset;cursor:pointer;flex:1;text-align:center;background:#2f6fed;border-radius:4px;padding:4px 0">保存</button>
        <button data-f="send" style="all:unset;cursor:pointer;flex:1;text-align:center;background:#2a2a35;border-radius:4px;padding:4px 0">立即发送</button>
        <button data-f="pause" style="all:unset;cursor:pointer;flex:1;text-align:center;background:#2a2a35;border-radius:4px;padding:4px 0">暂停</button>
      </div>
      <div data-f="log" style="margin-top:6px;color:#9aa0b4;word-break:break-all"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const $ = (name) => panel.querySelector(`[data-f="${name}"]`);
  const elInterval = $('interval');
  const elMessage = $('message');
  const elStatus = $('status');
  const elLog = $('log');
  const elBody = $('body');
  const elPause = $('pause');

  function fmt(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  let logTimer = 0;
  function log(msg) {
    elLog.textContent = msg;
    clearTimeout(logTimer);
    logTimer = setTimeout(() => (elLog.textContent = ''), 8000);
  }

  function updatePanel() {
    elStatus.textContent = cfg.enabled ? `下次 ${fmt(remainingSec)}` : '已暂停';
    elPause.textContent = cfg.enabled ? '暂停' : '继续';
  }

  elInterval.value = cfg.intervalMin;
  elMessage.value = cfg.message;
  updatePanel();

  $('toggle').addEventListener('click', () => {
    panelCollapsed = !panelCollapsed;
    elBody.style.display = panelCollapsed ? 'none' : '';
    $('toggle').textContent = panelCollapsed ? '▸' : '—';
  });

  $('save').addEventListener('click', () => {
    const v = parseFloat(elInterval.value);
    if (v >= 0.5 && v <= 1440) {
      cfg.intervalMin = v;
    } else {
      elInterval.value = cfg.intervalMin;
    }
    cfg.message = elMessage.value.trim() || DEFAULT_MESSAGE;
    elMessage.value = cfg.message;
    saveCfg();
    remainingSec = cfg.intervalMin * 60;
    updatePanel();
    log('已保存');
  });

  $('send').addEventListener('click', () => sendMessage());

  elPause.addEventListener('click', () => {
    cfg.enabled = !cfg.enabled;
    if (cfg.enabled) remainingSec = cfg.intervalMin * 60;
    saveCfg();
    updatePanel();
  });

  // ---------- 油猴菜单 ----------

  GM_registerMenuCommand('立即发送一次', () => sendMessage());
  GM_registerMenuCommand('暂停 / 继续', () => {
    cfg.enabled = !cfg.enabled;
    if (cfg.enabled) remainingSec = cfg.intervalMin * 60;
    saveCfg();
    updatePanel();
  });
  GM_registerMenuCommand('显示 / 收起面板', () => $('toggle').click());
})();
