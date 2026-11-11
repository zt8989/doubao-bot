// 豆包（豆包 / 豆包工作）适配层：新建工作任务、切模式、选模型、填输入、
// 读回复。页面结构来自 magpie 的 doubao-work 插件（MIT），并补了三件事：
// 会话 id、会话消息全量读取、同一任务里续发消息。
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { App, Page } from "./cdp.mjs"
import { sleep } from "./util.mjs"

export const APPS = [
  { name: "豆包工作", mac: "DoubaoWork.app/Contents/MacOS/DoubaoWork", sub: "doubaowork" },
  { name: "豆包", mac: "Doubao.app/Contents/MacOS/Doubao", sub: "" },
]

export function dataDir(platform = process.platform, home = os.homedir()) {
  if (process.env.DOUBAO_WORK_HOME) return process.env.DOUBAO_WORK_HOME
  // 与 magpie 插件共用同一个 profile：那里已经登录过，dws 直接接上
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "magpie-doubao-work")
  }
  if (platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local")
    return path.win32.join(base, "magpie-doubao-work")
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "magpie-doubao-work")
}

export function choose(platform = process.platform, home = os.homedir(), exists = fs.existsSync) {
  const P = platform === "win32" ? path.win32 : path.posix
  const base = dataDir(platform, home)
  if (process.env.DOUBAO_WORK_APP) {
    const bin = process.env.DOUBAO_WORK_APP
    return { app: /doubaowork/i.test(bin) ? APPS[0] : APPS[1], binary: bin, dataDir: base }
  }
  for (const app of APPS) {
    const bin = P.join("/Applications", app.mac)
    if (exists(bin)) return { app, binary: bin, dataDir: app.sub ? P.join(base, app.sub) : base }
  }
  return { app: APPS[0], binary: P.join("/Applications", APPS[0].mac), dataDir: base }
}

// 两端的聊天页都在自己的 scheme 下：doubao://doubao-chat/chat[/id]
export const isChat = (url) => /^(doubao|doubaowork|chrome):\/\/(doubao|doubaowork)-chat\/chat/.test(String(url))

// owns 判断一组 CDP target 里有没有聊天页（list 级谓词，与 magpie 插件一致；
// 不能把 url 级的 isChat 直接当 owns 传给 App，否则整表永远匹配不上）
export const owns = (list) => list.some((t) => isChat(t.url))

const LIB = String.raw`
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (el) => { for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
const message = (el) => {
  if (!el) return null;
  const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  let f = k && el[k];
  for (let d = 0; f && d < 40; d++, f = f.return) { const m = f.memoizedProps && f.memoizedProps.message; if (m && m.message_id !== undefined && m.content_blocks_v2) return m; }
  return null;
};
const blocksOf = (m) => {
  const blocks = (m && m.content_blocks_v2) || [];
  const thinking = new Set(blocks.filter((b) => b.block_type === 10040).map((b) => b.block_id));
  let text = "", reasoning = "";
  for (const b of blocks) {
    const t = b.content && b.content.text_block;
    if (b.block_type !== 10000 || !t || typeof t.text !== "string") continue;
    if (b.parent_id && thinking.has(b.parent_id)) reasoning += t.text; else text += t.text;
  }
  return { text, reasoning };
};
const convId = () => ((location.href.match(/chat\/(\d+)/) || [])[1] || "");
const counts = () => ({ sends: $$("[data-testid=send_message]").length, receives: $$("[data-testid=receive_message]").length });
`

const js = (body) => `(async () => { ${LIB}\n${body} })()`

export const STATE = js(`
  const sb = $("[data-testid=sidebar_bottom]");
  const login = sb ? $$("button, [role=button]", sb).some((b) => b.innerText.trim() === "登录") : false;
  const out = location.href.includes("from_logout");
  const c = counts();
  const modeBtn = $("[data-testid=chat_input_action_mode]");
  return { url: location.href, convId: convId(), signedIn: !!sb && !login && !out,
    name: sb ? sb.innerText.split("\\n")[0].trim() : "",
    input: !!($(".ProseMirror") && $(".ProseMirror").editor),
    mode: modeBtn ? modeBtn.innerText.trim() : "", sends: c.sends, receives: c.receives };
`)

export const NEW_TASK = js(`
  const b = $("[data-testid=create_office_task_button] [role=button]") || $("[data-testid=create_office_task_button]");
  if (!b) return "没有“新建工作任务”按钮（豆包可能停在别的页面）";
  b.click();
  for (let i = 0; i < 60; i++) {
    await wait(100);
    const ed = $(".ProseMirror") && $(".ProseMirror").editor;
    if (!ed) continue;
    if (!$$("[data-testid=send_message]").length) return "";
  }
  return "新建工作任务没有打开";
`)

// 工作任务默认在“本地电脑”，也就是让豆包在本机跑命令；
// 会话默认在本地跑，只有显式要云电脑时才切。
export const MODE = (label) => js(`
  const label = ${JSON.stringify(label)};
  const b = $("[data-testid=chat_input_action_mode]");
  if (!b) return "没有模式按钮";
  if (b.innerText.includes(label)) return "";
  press(b);
  let it;
  for (let i = 0; i < 25 && !it; i++) { await wait(100); it = $$("[role=menuitem]").find((e) => e.innerText.includes(label)); }
  if (!it) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "模式菜单里没有 " + label; }
  press(it);
  for (let i = 0; i < 25; i++) { await wait(100); if (b.isConnected && b.innerText.includes(label)) return ""; }
  return "模式停在 " + b.innerText.trim();
`)

export const MENU = js(`
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return { error: "没有模型按钮" };
  press(b);
  let menu;
  for (let i = 0; i < 30 && !menu; i++) { await wait(100); menu = $$("[role=menu]").find((m) => $$("[role=menuitem]", m).length); }
  if (!menu) return { error: "模型菜单没有出现" };
  await wait(250);
  const rows = $$("[role=menuitem]", menu).filter((e) => e.getAttribute("aria-haspopup") !== "menu")
    .map((e) => ({ label: e.innerText.split("\\n")[0].trim() })).filter((r) => r.label);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { rows };
`)

export const pickModel = (label) => js(`
  const label = ${JSON.stringify(label)};
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return "没有模型按钮";
  if (b.innerText.split("\\n")[0].trim() === label) return "";
  press(b);
  let it;
  for (let i = 0; i < 25 && !it; i++) { await wait(100); it = $$("[role=menu] [role=menuitem]").find((e) => e.innerText.split("\\n")[0].trim() === label); }
  if (!it) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "模型菜单里没有 " + label; }
  if (it.innerText.includes("升级")) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "upgrade"; }
  press(it);
  await wait(300);
  return "";
`)

export const fill = (text) => js(`
  const ed = $(".ProseMirror") && $(".ProseMirror").editor;
  if (!ed) return -1;
  const lines = ${JSON.stringify(String(text).split("\n"))};
  ed.chain().clearContent(true).insertContent(lines.map((l) => ({ type: "paragraph", content: l ? [{ type: "text", text: l }] : [] }))).focus("end").run();
  return ed.getText({ blockSeparator: "\\n" }).length;
`)

export const READ = js(`
  const c = counts();
  const receives = $$("[data-testid=receive_message]");
  const r = message(receives[receives.length - 1]);
  const base = { sends: c.sends, receives: c.receives, convId: convId() };
  if (!r) return { ...base, reply: false };
  const { text, reasoning } = blocksOf(r);
  const ext = r.ext || {};
  return { ...base, reply: true, id: String(r.message_id || r.unique_id || ""), text, reasoning,
    finished: ext.is_finish === "1" || !!(r.final_status && r.final_status.session),
    status: (r.final_status && r.final_status.session) || "", reason: ext.finish_reason_chat || "",
    usage: ext.context_window_usage || "", error: r.error_details ? JSON.stringify(r.error_details) : "" };
`)

export const COUNTS = js(`
  const c = counts();
  return { ...c, convId: convId() };
`)

// CONVO 按 DOM 顺序读整个任务的消息：user = 发出去的那侧，assistant = 回复那侧。
export const CONVO = js(`
  const nodes = $$("[data-testid=send_message], [data-testid=receive_message]");
  const messages = [];
  for (const el of nodes) {
    const m = message(el);
    if (!m) continue;
    const { text, reasoning } = blocksOf(m);
    const ext = m.ext || {};
    messages.push({ role: el.getAttribute("data-testid") === "send_message" ? "user" : "assistant",
      id: String(m.message_id || m.unique_id || ""), text, reasoning,
      finished: ext.is_finish === "1", reason: ext.finish_reason_chat || "",
      usage: ext.context_window_usage || "",
      error: m.error_details ? JSON.stringify(m.error_details) : "" });
  }
  return { convId: convId(), url: location.href, messages };
`)

// TASKS 读侧边栏里的全部工作任务：id、标题、是否当前、是否还在跑、项目归属。
// 条目上有 conversation/{conversationId,name}、isActive、status（loading = 还在跑）；
// 项目里的条目用 closest 找到所属项目块，块内位于条目之前的最后一个项目名按钮就是它的项目。
export const TASKS = js(`
  const clean = (s) => String(s).replace(/[\\s\\u200b-\\u200f\\ufeff]/g, "");
  const OPS = new Set(["项目主页", "新对话", "更多", "归档对话", "新建项目", "对话列表设置"]);
  const projOf = (el) => {
    const sec = el.closest("[data-testid=project-grouped-section]");
    if (!sec) return "";
    const names = [...sec.querySelectorAll("button")].filter((b) => { const t = clean(b.innerText); return t && !OPS.has(t); });
    const before = names.filter((b) => b.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before.length ? clean(before[before.length - 1].innerText) : "";
  };
  const items = $$("[data-testid=conversation-list-v2-item]");
  return items.map((el) => {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    let f = k && el[k], c = null;
    for (let i = 0; f && i < 15; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && p.conversation) { c = p; break; }
    }
    const a = el.closest("a");
    const href = el.getAttribute("href") || (a && a.getAttribute("href")) || "";
    const conv = (c && c.conversation) || {};
    const st = c && c.status && c.status.props ? c.status.props : {};
    const m = String(conv.conversationId || href).match(/\\d{8,}/);
    return { id: m ? m[0] : String(conv.conversationId || ""),
      title: String(conv.name || (el.innerText || "").split("\\n")[0] || "").trim(),
      active: !!(c && c.isActive), running: st.status === "loading", unread: st.unreadCount || 0,
      pending: st.pendingLabel || "", project: projOf(el) };
  }).filter((t) => t.id);
`)

// PROJECTS 列侧边栏「项目」分组下的项目名。
export const PROJECTS = js(`
  const clean = (s) => String(s).replace(/[\\s\\u200b-\\u200f\\ufeff]/g, "");
  const OPS = new Set(["项目主页", "新对话", "更多", "归档对话", "新建项目", "对话列表设置"]);
  const sec = $("[data-testid=project-grouped-section]");
  if (!sec) return [];
  const out = [];
  for (const b of sec.querySelectorAll("button")) {
    const t = clean(b.innerText);
    if (t && !OPS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
`)

// 跑动中标志：composer 的「结束任务」按钮（interrupt 按钮是积压消息的撤回，
// 与任务是否在跑无关，不参与判定）。
export const RUNNING_STATE = js(`
  return {
    stopBtn: !!document.querySelector('button[aria-label="结束任务"]'),
    interrupt: !!document.querySelector("[data-testid=queue-item-interrupt]"),
  };
`)

// NEW_TASK_IN_PROJECT 点项目行上的「新对话」，在该项目下新建工作任务。
// 项目名按钮和「新对话」都带零宽字符，匹配前一律清洗。
export const NEW_TASK_IN_PROJECT = (project) =>
  js(`
  const project = ${JSON.stringify(String(project))};
  const clean = (s) => String(s).replace(/[\\s\\u200b-\\u200f\\ufeff]/g, "");
  // 行操作按钮是纯图标，文本在 aria-label/title 上，innerText 是空的
  const label = (b) => clean(b.innerText || b.getAttribute("aria-label") || b.getAttribute("title") || "");
  const nameBtn = $$("button").find((b) => clean(b.innerText) === project);
  if (!nameBtn) return "没有找到项目 " + project;
  // 行操作按钮是 hover 才挂载的：把 over/enter/move 五连都发一遍，等它渲染出来
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    try { nameBtn.dispatchEvent(new PointerEvent(t, { bubbles: true, view: window, pointerType: "mouse" })) } catch { nameBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window })) }
  }
  await wait(400);
  let row = nameBtn, newBtn = null;
  for (let i = 0; row && i < 10 && !newBtn; i++, row = row.parentElement) {
    newBtn = [...row.querySelectorAll("button")].find((b) => label(b) === "新对话");
  }
  if (!newBtn) return "项目 " + project + " 的行里没有「新对话」按钮";
  // 已经在新建页（无 id 的 /chat）就直接用，豆包发首条消息后才分配会话 id
  if (/\\/chat\\/?$/.test(String(location.href))) return "";
  const before = String(location.href);
  press(newBtn);
  for (let i = 0; i < 150; i++) {
    await wait(100);
    const now = String(location.href);
    if (now !== before && !/launcher|background/.test(now)) return "";
  }
  return "点了「新对话」但页面没有跳到新任务";
`)

// openTaskById 在侧边栏找到目标任务并点它，等页面切过去；已在目标页就直说成功。
export const openTaskById = (id) =>
  js(`
  const id = ${JSON.stringify(String(id))};
  if (String(location.href).includes("/chat/" + id)) return "";
  const items = $$("[data-testid=conversation-list-v2-item]");
  const hit = items.find((el) => {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    let f = k && el[k];
    for (let i = 0; f && i < 15; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && p.conversation && String(p.conversation.conversationId) === id) return true;
    }
    const a = el.closest("a");
    return String(el.getAttribute("href") || (a && a.getAttribute("href")) || "").includes("/chat/" + id);
  });
  if (!hit) return "侧边栏里没有任务 " + id;
  press(hit.closest("a") || hit);
  for (let i = 0; i < 60; i++) { await wait(100); if (String(location.href).includes("/chat/" + id)) return ""; }
  return "点了任务 " + id + " 但页面没切过去";
`)

// archiveTaskById 点目标任务条目上的「归档对话」按钮，等条目从列表消失。
export const archiveTaskById = (id) =>
  js(`
  const id = ${JSON.stringify(String(id))};
  const find = () => {
    const items = $$("[data-testid=conversation-list-v2-item]");
    return items.find((el) => {
      const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
      let f = k && el[k];
      for (let i = 0; f && i < 15; i++, f = f.return) {
        const p = f.memoizedProps;
        if (p && p.conversation && String(p.conversation.conversationId) === id) return true;
      }
      const a = el.closest("a");
      return String(el.getAttribute("href") || (a && a.getAttribute("href")) || "").includes("/chat/" + id);
    });
  };
  const el = find();
  if (!el) return "侧边栏里没有任务 " + id;
  const btn = el.querySelector('[data-testid=conversation-list-v2-item-hide]');
  if (!btn) return "任务 " + id + " 的归档按钮没有找到";
  press(btn);
  for (let i = 0; i < 50; i++) { await wait(100); if (!find()) return ""; }
  return "点了归档但任务 " + id + " 还在列表里";
`)

export const MODELS = { auto: { label: "自动", name: "自动" } }

export class DoubaoError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    Object.assign(this, { code }, extra)
  }
}

// Doubao 一次只跑一个请求（只有一个窗口），所有动作串行。
export class Doubao {
  constructor({
    app,
    openPage = Page.open,
    poll = 200,
    idleMs = 180000,
    totalMs = 1800000,
    modelsFile,
  } = {}) {
    if (!app) {
      const c = choose()
      app = new App({ binary: c.binary, dataDir: c.dataDir, owns })
    }
    this.app = app
    Object.assign(this, { openPage, poll, idleMs, totalMs })
    this.modelsFile = modelsFile ?? (app.dataDir ? path.join(app.dataDir, "models.json") : "")
    this.page = null
  }

  models() {
    const cached = this.modelsFile ? safeRead(this.modelsFile) : null
    if (cached?.models && Object.keys(cached.models).length) return { ...MODELS, ...cached.models }
    return { ...MODELS }
  }

  async connect(signal) {
    if (this.page && !this.page.closed) return this.page
    const port = await this.app.start({ signal })
    this.page = await this.openPage(port, (t) => isChat(t.url))
    if (!this.page) {
      throw new DoubaoError("豆包的聊天页没有打开：请先在豆包里点开一个对话窗口", "doubao_no_window")
    }
    return this.page
  }

  async state(signal) {
    const page = await this.connect(signal)
    return page.eval(STATE)
  }

  // openTask 新建一个工作任务，按需切模式/选模型，发第一条消息，等回复跑完。
  async openTask(prompt, { mode = "local", model = "auto", project = "", signal, onUpdate } = {}) {
    const page = await this.connect(signal)
    const s = await page.eval(STATE)
    if (!s.signedIn) throw new DoubaoError("豆包没有登录，请先在豆包窗口里登录", "doubao_signed_out")

    const step = async (expr, what) => {
      const why = await page.eval(expr)
      if (why) throw new DoubaoError(`豆包${what}失败：${why}`, "doubao_ui")
    }
    if (project) {
      await step(NEW_TASK_IN_PROJECT(project), `在项目 ${project} 下新建工作任务`)
    } else {
      await step(NEW_TASK, "新建工作任务")
    }
    await step(MODE(mode === "cloud" ? "云电脑" : "本地电脑"), "切换模式")
    if (model && model !== "auto") {
      const table = this.models()
      const label = (table[model] ?? table.auto).label
      const picked = await page.eval(pickModel(label))
      if (picked === "upgrade") throw new DoubaoError(`${label} 需要升级豆包会员`, "doubao_upgrade")
      if (picked) throw new DoubaoError(`豆包选择模型失败：${picked}`, "doubao_ui")
    }
    const baseline = await page.eval(COUNTS)
    await sendText(page, prompt, signal)
    const reply = await this.waitReply({ baseline, signal, onUpdate })
    return { convId: reply.convId, reply }
  }

  // send 在当前这个工作任务里续一条消息（会话不换）。
  async send(text, { signal, onUpdate } = {}) {
    const page = await this.connect(signal)
    const baseline = await page.eval(COUNTS)
    if (!baseline.convId) throw new DoubaoError("当前没有可续的任务，请先 dws open", "doubao_no_task")
    await sendText(page, text, signal)
    const reply = await this.waitReply({ baseline, signal, onUpdate })
    return { convId: reply.convId || baseline.convId, reply }
  }

  async read(signal) {
    const page = await this.connect(signal)
    return page.eval(READ)
  }

  // steer 在任务跑动中追加指令：Command+Enter 发送，不打断当前任务
  // （普通 Enter/点击发送会把在跑的任务打断）。只确认发出，不等回复。
  async steer(text, { signal } = {}) {
    const page = await this.connect(signal)
    const before = await page.eval(READ)
    const baseline = before?.sends ?? 0
    const n = await page.eval(fill(text))
    if (n < 0) throw new DoubaoError("豆包的输入框没有找到。", "doubao_ui")
    // modifiers: 4 = Meta/Command（CDP 键盘事件修饰位）
    await page.key("Enter", { code: "Enter", keyCode: 13, text: "\r", modifiers: 4 })
    const until = Date.now() + 15000
    while (Date.now() < until) {
      await sleep(400, signal)
      const r = await page.eval(READ)
      if ((r?.sends ?? 0) > baseline) return { ok: true, sends: r.sends }
    }
    throw new DoubaoError("豆包没有把这条追加指令发出去", "doubao_ui")
  }

  async convo(signal) {
    const page = await this.connect(signal)
    return page.eval(CONVO)
  }

  // tasks 列出侧边栏里的全部工作任务（含不在本地记录里的，带项目归属）。
  async tasks(signal) {
    const page = await this.connect(signal)
    return page.eval(TASKS)
  }

  // projects 列侧边栏「项目」分组下的项目名。
  async projects(signal) {
    const page = await this.connect(signal)
    return page.eval(PROJECTS)
  }

  // goto 把窗口切到目标任务，返回已连接的页面；已在该任务上就不动。
  async goto(id, signal) {
    const page = await this.connect(signal)
    const why = await page.eval(openTaskById(id))
    if (why) throw new DoubaoError(`切换任务失败：${why}`, "doubao_ui")
    return page
  }

  // archive 把窗口侧边栏里的目标任务归档收起。
  async archive(id, signal) {
    const page = await this.connect(signal)
    const why = await page.eval(archiveTaskById(id))
    if (why) throw new DoubaoError(`归档任务失败：${why}`, "doubao_ui")
  }

  // stop 中断正在跑的任务：聚焦输入框后双击 Esc（豆包 composer 的中断方式，
  // Esc 必须走 CDP 输入事件才是 trusted，页面内 JS 派发无效）。没在跑返回 false。
  async stop(id, signal) {
    const page = await this.goto(id, signal)
    const s = await page.eval(RUNNING_STATE)
    if (!s.stopBtn) {
      // 任务刚发起时按钮有延迟，再等 8 秒确认
      for (let i = 0; i < 20; i++) {
        await sleep(400, signal)
        const s2 = await page.eval(RUNNING_STATE)
        if (s2.stopBtn) { s.stopBtn = true; break }
      }
      if (!s.stopBtn) return false
    }
    await page.eval(`(() => { const pm = document.querySelector(".ProseMirror"); if (pm) pm.focus(); })()`)
    await page.key("Escape", { keyCode: 27 })
    await sleep(250, signal)
    await page.key("Escape", { keyCode: 27 })
    // 等结束任务按钮消失（最多 20 秒；豆包响应双击 Esc 有时偏慢）
    for (let i = 0; i < 50; i++) {
      await sleep(400, signal)
      const s2 = await page.eval(RUNNING_STATE)
      if (!s2.stopBtn) return true
    }
    throw new DoubaoError("双击 Esc 后任务仍在跑动", "doubao_ui")
  }

  // waitReply 从 baseline 之后等“一条新的、已跑完的回复”。
  async waitReply({ baseline = { sends: 0, receives: 0 }, signal, onUpdate = () => {} } = {}) {
    const start = Date.now()
    let last = null
    let changed = start
    for (;;) {
      await sleep(this.poll, signal)
      let r
      try {
        r = await this.read(signal)
      } catch (e) {
        if (signal?.aborted) throw e
        // 页面偶发连不上（切任务/重渲染）不算失败，继续等
        if (Date.now() - start > 60000) throw e
        continue
      }
      if (!(r.sends > baseline.sends)) {
        if (Date.now() - start > 20000) {
          throw new DoubaoError("豆包没有把这条消息发出去", "doubao_ui")
        }
        continue
      }
      if (!(r.receives > baseline.receives)) {
        if (Date.now() - start > 180000) {
          throw new DoubaoError("豆包三分钟没有回复", "doubao_timeout")
        }
        continue
      }
      if (!r.reply) continue
      if (!last || r.text !== last.text || r.reasoning !== last.reasoning) {
        changed = Date.now()
        onUpdate(r)
      }
      last = r
      if (r.finished) {
        const badFinish = !/^succeed/i.test(r.reason || "succeed")
        if (!r.text && !r.reasoning && (r.error || badFinish)) {
          throw new DoubaoError(
            `豆包这条回复失败了（${r.status || r.reason || r.error || "unknown"}）`,
            "doubao_failed"
          )
        }
        return r
      }
      if (Date.now() - changed > this.idleMs) {
        throw new DoubaoError(`豆包回复停了 ${Math.round(this.idleMs / 60000)} 分钟`, "doubao_timeout")
      }
      if (Date.now() - start > this.totalMs) {
        throw new DoubaoError(`豆包这次跑了 ${Math.round(this.totalMs / 60000)} 分钟还没完`, "doubao_timeout")
      }
    }
  }

  close() {
    this.page?.close()
    this.page = null
  }
}

async function sendText(page, text, signal) {
  const n = await page.eval(fill(text))
  if (n < 0) throw new DoubaoError("豆包的输入框没有找到", "doubao_ui")
  signal?.throwIfAborted?.()
  await page.key("Enter", { keyCode: 13, text: "\r" })
}

function safeRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}
