// 豆包（豆包 / 豆包工作）适配层：新建工作任务、切模式、选模型、填输入、
// 读回复。页面结构来自 magpie 的 doubao-work 插件（MIT），并补了三件事：
// 会话 id、会话消息全量读取、同一任务里续发消息。
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { App, Page } from "./cdp.mjs"
import { sleep, isFreshTask, pickNewTask, freshTaskCandidates } from "./util.mjs"

// promptHead 把提示词压成用来认领「这句是不是我发的」的指纹：去空白、取前 40 字。
// 别用整段比对：超长提示词在气泡里可能被折叠/转义，只认开头就够唯一了。
const promptHead = (s) => String(s ?? "").replace(/[\s\u200b-\u200f\ufeff]/g, "").slice(0, 40)

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
  const sends = $$("[data-testid=send_message]");
  const receives = $$("[data-testid=receive_message]");
  const r = message(receives[receives.length - 1]);
  const lastSendId = sends.length ? String((message(sends[sends.length - 1]) || {}).message_id ?? "") : "";
  const base = { sends: c.sends, receives: c.receives, convId: convId(), lastSendId };
  if (!r) return { ...base, reply: false };
  const { text, reasoning } = blocksOf(r);
  const ext = r.ext || {};
  return { ...base, reply: true, id: String(r.message_id || r.unique_id || ""), text, reasoning,
    finished: ext.is_finish === "1" || !!(r.final_status && r.final_status.session),
    status: (r.final_status && r.final_status.session) || "", reason: ext.finish_reason_chat || "",
    usage: ext.context_window_usage || "", error: r.error_details ? JSON.stringify(r.error_details) : "" };
`)

// SIGNATURE 比 COUNTS 多带末条消息的 id：切任务时 URL 先变、消息列表后换，
// 用签名变化 + 连续两读一致来判断「DOM 真的换到目标会话了」。
export const SIGNATURE = js(`
  const c = counts();
  const ss = $$("[data-testid=send_message]");
  const rs = $$("[data-testid=receive_message]");
  const idOf = (el) => { const m = message(el); return m ? String(m.message_id ?? m.unique_id ?? "") : ""; };
  return { ...c, convId: convId(),
    lastSendId: ss.length ? idOf(ss[ss.length - 1]) : "",
    lastReceiveId: rs.length ? idOf(rs[rs.length - 1]) : "" };
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

// 输入框里还剩多少字（0 = 已经发出去清空了）。发消息的确认靠它，不靠消息条数
// （排队模式下消息这一轮不会进列表）。
export const INPUT_LEN = js(`
  const ed = $(".ProseMirror") && $(".ProseMirror").editor;
  if (!ed) return -1;
  return ed.getText({ blockSeparator: "\\n" }).length;
`)

// 发消息的两个模式对应的按键：默认模式占 Enter，另一个占 Command+Enter。
//   steer 是「插进当前这一轮」，queue 是「排到这一轮之后」。
export function keyForMode(mode, defaultMode = "steer") {
  const m = mode === "queue" ? "queue" : "steer"
  const d = defaultMode === "queue" ? "queue" : "steer"
  return m === d ? "enter" : "cmd-enter"
}

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
    messageMode = "steer",
  } = {}) {
    if (!app) {
      const c = choose()
      app = new App({ binary: c.binary, dataDir: c.dataDir, owns })
    }
    this.app = app
    Object.assign(this, { openPage, poll, idleMs, totalMs, messageMode })
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

  // readTasks 读侧边栏任务快照；读不到返回 null（区别于「确实一条任务都没有」的空数组）。
  async readTasks(page, signal) {
    try {
      return (await page.eval(TASKS)) ?? []
    } catch (e) {
      if (signal?.aborted) throw e
      return null
    }
  }

  // locateNewTask 轮询侧边栏，等「点新建之后多出来的那条会话」出现；等不到返回 null。
  // 这是新会话 id 的主证据：窗口 URL 在单实例共享下会被用户自己切走，不能当唯一判据。
  async locateNewTask(page, beforeTasks, { timeoutMs = 30000, expectTitle = "", signal } = {}) {
    if (!Array.isArray(beforeTasks)) return null
    const start = Date.now()
    for (;;) {
      const hit = pickNewTask(beforeTasks, (await this.readTasks(page, signal)) ?? [], { expectTitle })
      if (hit) return hit
      if (Date.now() - start > timeoutMs) return null
      await sleep(this.poll, signal)
    }
  }

  // locateNewCandidates 轮询侧边栏，等差集里出现候选；返回排好序的候选全集（可能不止一条）。
  async locateNewCandidates(page, beforeTasks, { timeoutMs = 30000, expectTitle = "", signal } = {}) {
    if (!Array.isArray(beforeTasks)) return []
    const start = Date.now()
    for (;;) {
      const candidates = freshTaskCandidates(beforeTasks, (await this.readTasks(page, signal)) ?? [], {
        expectTitle,
      })
      if (candidates.length) return candidates
      if (Date.now() - start > timeoutMs) return []
      await sleep(this.poll, signal)
    }
  }

  // convHasPrompt 确认这条会话里确实有我们刚发的那句提示词。
  // 差集只能说明「它是新的」，并发时（用户自己的 agent 也在建任务）会有多条新任务，
  // 只有回读它自己的消息才能定案；对不上就换下一条候选。
  async convHasPrompt(id, prompt, { signal } = {}) {
    const head = promptHead(prompt)
    if (!head) return true
    try {
      const page = await this.goto(id, signal)
      const convo = await page.eval(CONVO)
      const mine = (convo?.messages ?? []).filter((m) => m.role === "user").pop()
      const got = promptHead(mine?.text ?? "")
      return got ? got.includes(head) || head.includes(got) : false
    } catch (e) {
      if (signal?.aborted) throw e
      return false
    }
  }

  // replyOfConv 保证交出去的回复确实来自目标会话：等回复的这段时间里窗口可能被用户切走，
  // 那会儿 waitReply 读到的整段内容是**别人**的会话（台账里的 url 也会跟着记错）。
  // 切不到目标会话时宁可交空，也不把别人的回复当成它的结果。
  async replyOfConv(id, reply, { timeoutMs = 120000, signal, force = false } = {}) {
    const target = String(id ?? "").trim()
    const at = String((await this.state(signal))?.convId ?? "").trim()
    if (!force && at === target) {
      if (reply) reply.convId = target
      return reply ?? null
    }
    // 任务还在生成回复时点它，页面可能切不过去：隔一会儿重试，直到落定或超时。
    let pinned = false
    const deadline = Date.now() + timeoutMs
    while (!pinned) {
      try {
        await this.goto(target, signal)
        pinned = true
      } catch (e) {
        if (signal?.aborted) throw e
      }
      if (pinned || Date.now() > deadline) break
      await sleep(1500, signal)
    }
    if (!pinned) return null
    const page = await this.connect(signal)
    let r = await page.eval(READ).catch(() => null)
    const start = Date.now()
    // 回复可能还在流：等它落定再交，别把半条回复当成第一轮的结果。
    while (!(r?.reply && r?.finished) && Date.now() - start < timeoutMs) {
      await sleep(this.poll, signal)
      r = await page.eval(READ).catch(() => r)
    }
    // url 按目标 id 拼，别取「此刻的窗口地址」：回复读完后窗口可能又被切回用户自己那条，
    // 那样记下来的 url 会把用户会话当成本次新建的。
    return { ...(r ?? {}), convId: target, url: `chrome://doubao-chat/chat/${target}` }
  }

  // openTask 新建一个工作任务，按需切模式/选模型，发第一条消息，等回复跑完。
  // noWait=true 时只确认首句送达并拿到新会话 id，不等第一轮回复（通知类新会话用）。
  async openTask(prompt, { mode = "local", model = "auto", project = "", noWait = false, signal, onUpdate } = {}) {
    const page = await this.connect(signal)
    const s = await page.eval(STATE)
    if (!s.signedIn) throw new DoubaoError("豆包没有登录，请先在豆包窗口里登录", "doubao_signed_out")
    // 记下点「新建工作任务」之前所在的会话 id，等回读时必须确认窗口真的换到了新会话。
    // 否则 NEW_TASK 哪怕没切走，sendText 也会在旧会话里把提示词发出去，waitReply 还会把
    // 旧会话的回复当成新会话的回复带回来。
    const beforeConvId = s.convId
    // 同时记下侧边栏的任务集合：新建后多出来的那条 id 才是本次新会话。窗口 id 只有一个，
    // 用户点回自己的任务时读到的就是别人的 id——两条假结论（误判没建 / 记成别人的会话）
    // 都来自这一个证据源。
    const beforeTasksRead = await this.readTasks(page, signal)
    // 快照为空、但窗口里明明停着一个会话：这是渲染没跟上，不是「侧边栏真的空」。
    // 拿一份残缺快照做差集，会把用户已有的任务当成刚建出来的那条，宁可不认。
    const beforeTasks =
      Array.isArray(beforeTasksRead) &&
      beforeTasksRead.length === 0 &&
      /^\d{8,}$/.test(String(beforeConvId ?? "").trim())
        ? null
        : beforeTasksRead

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
    // 发送前先等窗口真的离开旧会话：切页有延迟，急着发会把提示词发进旧会话，
    // 事后只能靠回读猜。等不到就一条消息都不发，直接报错。
    const switched = await this.waitConvSwitch(beforeConvId, { timeoutMs: 15000, signal })
    if (!switched.switched) {
      throw new DoubaoError(
        `新建工作任务失败：点完之后 15 秒窗口仍停在旧会话 ${beforeConvId || "(空)"}，` +
          `首条消息没有发出（避免发进旧会话）。`,
        "doubao_new_task"
      )
    }
    // baseline 要等 DOM 稳定再读：新建后消息列表还在换，读到旧会话的条数会让
    // waitReply 判不出「发出去了」（长会话下尤其明显）。
    const baseline = await this.stableCounts(page, signal)
    await sendText(page, prompt, signal)
    // noWait：只确认「首句发出去了」并回读到新会话 id，不等第一轮回复。
    // 通知类新会话要的就是这个——等回复会把调用方的轮询拖到超时。
    if (noWait) {
      const sent = await this.confirmSent(page, baseline, { signal })
      // 主证据改成窗口回读的 convId：confirmSent 时窗口已被 waitConvSwitch 切到新会话，
      // 这个 id 才是本次新建的那条。原先先看侧边栏差集，差集可能命中「还没渲染进
      // beforeTasks 的旧会话」——38454515298487298 被 15:34 / 15:49 两次"新建"复用就是
      // 这么来的：第一次的会话没进 before 快照，第二次差集把它当新任务返回了。
      let convId = String(sent?.convId ?? "").trim()
      if (!/^\d{8,}$/.test(convId) || convId === String(beforeConvId ?? "").trim()) {
        convId = await this.waitNewConvId(beforeConvId, { timeoutMs: 20000, signal })
      }
      if (isFreshTask(beforeConvId, convId, { requireNewId: true })) {
        return { convId, reply: null, sent: true, locatedBy: "window" }
      }
      // 窗口拿不到新 id 才退回侧边栏差集，且必须用首句校验它确实是本次新建的——
      // 光凭差集不能区分「我建的」和「别人刚建 / 之前没渲染出来的」。
      const located = await this.locateNewTask(page, beforeTasks, { signal })
      if (located?.id && (await this.convHasPrompt(located.id, prompt, { signal }))) {
        return { convId: located.id, reply: null, sent: true, locatedBy: "sidebar" }
      }
      throw new DoubaoError(
        `新建工作任务失败：首句发出去了，但窗口回读的会话 id 是 ${convId || "(空)"}，` +
          `与新建前所在的 ${beforeConvId || "(空)"} 相同，侧边栏差集里也没有通过首句校验的新任务；` +
          `无法确认本次新会话落点，请 dws list 核对。`,
        "doubao_new_task"
      )
    }
    let reply
    try {
      reply = await this.waitReply({ baseline, signal, onUpdate })
    } catch (e) {
      // 回复没等到不等于派活失败：侧边栏里确实多出一条新会话，就如实返回「已派出、
      // 回复没取到」。报失败会让调用方重派，两条会话抢同一个工作区（#228 就是这么来的）。
      const located = await this.locateNewTask(page, beforeTasks, { timeoutMs: 10000, signal })
      if (located?.id && (e?.code === "doubao_timeout" || e?.code === "doubao_ui")) {
        return { convId: located.id, reply: null, sent: true, locatedBy: "sidebar", replyUnconfirmed: true }
      }
      throw e
    }
    // 主证据：侧边栏差集。窗口里读到的 id 可能是用户自己切过去的会话，不能当新会话 id。
    const candidates = await this.locateNewCandidates(page, beforeTasks, { signal })
    if (candidates.length) {
      // 并发时（用户自己的 agent 也在建任务）差集会有好几条：回读候选会话自己的消息，
      // 认领「首句是我发的那句」的那条；都对不上就退回候选首位，并标记未校验。
      let picked = candidates[0]
      let verified = false
      if (candidates.length > 1) {
        for (const cand of candidates.slice(0, 3)) {
          if (await this.convHasPrompt(cand.id, prompt, { signal })) {
            picked = cand
            verified = true
            break
          }
        }
      }
      // 回复一定从目标会话自己读（窗口在等回复期间可能被切走）；切不过去就交空。
      const tail = await this.replyOfConv(picked.id, reply, { signal, force: true })
      return {
        convId: picked.id,
        reply: tail,
        url: tail?.url ?? "",
        locatedBy: "sidebar",
        candidates: candidates.length,
        verified,
        replyUnconfirmed: !tail,
      }
    }
    // 兜底：窗口回读（老路）。拿到的会话 id 必须与新建前不同，否则就是没切走。此时提示词
    // 很可能发进了旧会话，绝不允许把旧 id 当新会话登记。
    if (!isFreshTask(beforeConvId, reply.convId, { requireNewId: true })) {
      // 会话 id 会随路由重建晚一步到位：回复已跑完时再补读一段，拿到具体新 id 就认。
      const late = await this.waitConvSwitch(beforeConvId, { timeoutMs: 20000, signal })
      if (late.switched && /^\d{8,}$/.test(late.convId)) {
        reply.convId = late.convId
      } else {
        throw new DoubaoError(
          `新建工作任务失败：发完首条消息回读到的会话 id 是 ${reply.convId || "(空)"}，` +
            `与新建前所在的 ${beforeConvId || "(空)"} 相同；窗口没有真正切到新会话，提示词可能已发进旧会话。`,
          "doubao_new_task"
        )
      }
    }
    return { convId: reply.convId, reply }
  }

  // send 在当前这个工作任务里续一条消息（会话不换）。
  async send(text, { signal, onUpdate } = {}) {
    const page = await this.connect(signal)
    const baseline = await this.stableCounts(page, signal)
    if (!baseline.convId) throw new DoubaoError("当前没有可续的任务，请先 dws open", "doubao_no_task")
    await sendText(page, text, signal)
    const reply = await this.waitReply({ baseline, signal, onUpdate })
    return { convId: reply.convId || baseline.convId, reply }
  }

  // sendAck 只确认「消息发出去了」，不等回复：通知这类只需要送达的场景用它，
  // 不会因为对面迟迟不回复而把调用方拖到超时、进而重发一遍。
  // 目标会话正在跑任务时走 Command+Enter 追加（不打断），空跑时用普通 Enter。
  async sendAck(text, { signal } = {}) {
    const page = await this.connect(signal)
    const baseline = await this.stableCounts(page, signal)
    if (!baseline.convId) throw new DoubaoError("当前没有可续的任务，请先 dws open", "doubao_no_task")
    const n = await page.eval(fill(text))
    if (n < 0) throw new DoubaoError("豆包的输入框没有找到", "doubao_ui")
    signal?.throwIfAborted?.()
    let running = {}
    try {
      running = await page.eval(RUNNING_STATE)
    } catch {}
    if (running?.stopBtn) {
      // modifiers: 4 = Meta/Command（CDP 键盘事件修饰位），与 steer 同一条路。
      await page.key("Enter", { code: "Enter", keyCode: 13, text: "\r", modifiers: 4 })
    } else {
      await page.key("Enter", { keyCode: 13, text: "\r" })
    }
    const until = Date.now() + 20000
    while (Date.now() < until) {
      await sleep(this.poll, signal)
      let sig = null
      try {
        sig = await page.eval(SIGNATURE)
      } catch (e) {
        if (signal?.aborted) throw e
        continue
      }
      // 长会话的消息列表是虚拟列表：新消息进来会挤掉一条，sends 不变，
      // 所以按末条 send 的 message_id 判断，不看条数。
      const sentNow = String(sig.lastSendId ?? "")
      const sentBase = String(baseline.lastSendId ?? "")
      if (sentNow && sentNow !== sentBase) return { convId: sig.convId || baseline.convId, sent: true }
      if (Number(sig.sends) > Number(baseline.sends)) return { convId: sig.convId || baseline.convId, sent: true }
    }
    throw new DoubaoError("豆包没有把这条消息发出去", "doubao_ui")
  }

  async read(signal) {
    const page = await this.connect(signal)
    return page.eval(READ)
  }

  // 发消息的两种模式，靠按键区分（豆包窗口语义）：
  //   steer：Enter —— 插进当前这一轮，不等这一轮结束；
  //   queue：Command+Enter —— 排到当前任务之后，这一轮跑完才轮到它。
  // 哪个键给哪个模式由配置的默认模式决定：默认模式占 Enter，另一个占 Command+Enter。
  //   messageMode=steer（默认）→ Enter = steer、Command+Enter = queue
  //   messageMode=queue         → Enter = queue、Command+Enter = steer
  // 只确认发出，不等回复（要等回复的用 send / sendAck）。
  async message(text, { mode = "steer", defaultMode = this.messageMode, signal } = {}) {
    const d = defaultMode === "queue" ? "queue" : "steer"
    const m = mode === "queue" ? "queue" : "steer"
    const key = keyForMode(m, d)
    const page = await this.connect(signal)
    const before = await page.eval(READ)
    const baseline = { sends: before?.sends ?? 0 }
    const n = await page.eval(fill(text))
    if (n < 0) throw new DoubaoError("豆包的输入框没有找到。", "doubao_ui")
    signal?.throwIfAborted?.()
    // modifiers: 4 = Meta/Command（CDP 键盘事件修饰位），只有 Command+Enter 带。
    await page.key(
      "Enter",
      key === "enter" ? { keyCode: 13, text: "\r" } : { code: "Enter", keyCode: 13, text: "\r", modifiers: 4 }
    )
    const until = Date.now() + 15000
    while (Date.now() < until) {
      await sleep(400, signal)
      const r = await page.eval(READ)
      if ((r?.sends ?? 0) > baseline.sends) return { ok: true, mode: m, key, sends: r.sends, queued: false }
      // 排队时这一轮的消息数不会涨：输入框清空、且出现排队气泡，就算已经排上了。
      let inputLen = -1
      try {
        inputLen = await page.eval(INPUT_LEN)
      } catch {}
      let running = {}
      try {
        running = await page.eval(RUNNING_STATE)
      } catch {}
      if (inputLen === 0 && (key === "cmd-enter" || running?.interrupt)) {
        return { ok: true, mode: m, key, sends: r?.sends ?? baseline.sends, queued: !!running?.interrupt }
      }
    }
    throw new DoubaoError(`豆包没有把这条消息发出去（模式 ${m}，按键 ${key}）`, "doubao_ui")
  }

  // steer 是「发消息 · steer 模式」的旧名字：保留给已有调用方，行为与 message(mode=steer) 一致。
  async steer(text, { signal } = {}) {
    return this.message(text, { mode: "steer", signal })
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
    const before = await page.eval(SIGNATURE).catch(() => null)
    const why = await page.eval(openTaskById(id))
    if (why) throw new DoubaoError(`切换任务失败：${why}`, "doubao_ui")
    await this.settleConv(page, String(id), before, { signal })
    return page
  }

  // settleConv 等窗口真的把目标任务渲染出来。openTaskById 只等 URL 里出现 /chat/<id>，
  // 而消息列表还要一拍才换：这期间读到的计数是上一个会话的，拿来当 baseline 就会
  // 「消息其实已经发出去，却因为计数一直不增而报没发出去」。判据：签名相对切换前变了，
  // 且连续两读一致。超时不算切任务失败，只是没等到稳定，交给调用方继续。
  async settleConv(page, id, before, { signal, timeoutMs = 6000, pollMs = 200 } = {}) {
    const start = Date.now()
    const want = String(id)
    const beforeKey = sigKey(before)
    let prev = null
    for (;;) {
      let sig = null
      try {
        sig = await page.eval(SIGNATURE)
      } catch (e) {
        if (signal?.aborted) throw e
      }
      if (sig && String(sig.convId ?? "") === want) {
        const key = sigKey(sig)
        // 相对切换前没变化 = 列表还是旧会话（或空 DOM），不能当目标会话的计数。
        const moved = !beforeKey || key !== beforeKey
        if (moved && prev && sigKey(prev) === key) return sig
        prev = sig
      }
      if (Date.now() - start > timeoutMs) return null
      await sleep(pollMs, signal)
    }
  }

  // stableCounts 读发送前的计数：连续两读一致才算数（DOM 正在重渲染时先等它停下来）。
  // 最多约 800ms，正常情况下第二读就稳定。
  async stableCounts(page, signal, { pollMs = 200, tries = 4 } = {}) {
    let prev = null
    for (let i = 0; i < tries; i++) {
      let sig = null
      try {
        sig = await page.eval(SIGNATURE)
      } catch (e) {
        if (signal?.aborted) throw e
      }
      if (sig && prev && sigKey(prev) === sigKey(sig)) return sig
      if (sig) prev = sig
      await sleep(pollMs, signal)
    }
    return prev ?? { sends: 0, receives: 0, convId: "" }
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

  // waitConvSwitch 等窗口真的离开 beforeConvId：切任务/新建任务后 location 里的会话 id
  // 有延迟，急着发消息会把提示词发进旧会话。读不到变化就返回 switched:false。
  async waitConvSwitch(beforeConvId, { timeoutMs = 15000, signal } = {}) {
    const start = Date.now()
    const before = String(beforeConvId ?? "").trim()
    // 新建前压根没有具体会话 id（停在空白 /chat）时无从判断变化，直接放行。
    if (!/^\d{8,}$/.test(before)) return { switched: true, convId: "" }
    let last = before
    for (;;) {
      let cur = last
      try {
        const r = await this.read(signal)
        cur = String(r?.convId ?? "").trim()
      } catch (e) {
        if (signal?.aborted) throw e
        cur = last
      }
      // 注意：空 id 也算“离开了旧会话”（刚点完停在新 /chat 页），但不能拿来记账。
      if (cur !== before) return { switched: true, convId: cur }
      last = cur
      if (Date.now() - start > timeoutMs) return { switched: false, convId: cur }
      await sleep(this.poll, signal)
    }
  }

  // confirmSent 只确认「这条消息真的进了会话」：末条 send 的 message_id 变了，或条数增加。
  // 长会话是虚拟列表，条数可能一直是满的，所以两个判据都看。
  async confirmSent(page, baseline, { timeoutMs = 20000, signal } = {}) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      await sleep(this.poll, signal)
      let sig = null
      try {
        sig = await page.eval(SIGNATURE)
      } catch (e) {
        if (signal?.aborted) throw e
        continue
      }
      const sentNow = String(sig?.lastSendId ?? "")
      const sentBase = String(baseline?.lastSendId ?? "")
      if ((sentNow && sentNow !== sentBase) || Number(sig?.sends) > Number(baseline?.sends)) return sig
    }
    throw new DoubaoError("豆包没有把这条消息发出去", "doubao_ui")
  }

  // waitNewConvId 等一个「具体的、与新建前不同」的会话 id：路由重建会晚一步才给 id。
  async waitNewConvId(beforeConvId, { timeoutMs = 20000, signal } = {}) {
    const before = String(beforeConvId ?? "").trim()
    const start = Date.now()
    for (;;) {
      let cur = ""
      try {
        cur = String((await this.read(signal))?.convId ?? "").trim()
      } catch (e) {
        if (signal?.aborted) throw e
      }
      if (/^\d{8,}$/.test(cur) && cur !== before) return cur
      if (Date.now() - start > timeoutMs) return ""
      await sleep(this.poll, signal)
    }
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
      // 「发出去了」不能只看条数：长会话的消息列表是虚拟列表，新消息进来会挤掉一条
      // 老消息，sends 一直不变。改为看末条 send 的 message_id 有没有换。
      const sentNow = String(r.lastSendId ?? "")
      const sentBase = String(baseline.lastSendId ?? "")
      const sent = (sentNow && sentNow !== sentBase) || Number(r.sends) > Number(baseline.sends)
      if (!sent) {
        // 条数比 baseline 还少：baseline 读自另一个会话（切任务时 DOM 还没换）。
        // 消息已经按下 Enter 送出去了，把账本折叠到当前会话再继续判回复。
        if (Number(r.sends) > 0 && Number(r.sends) < Number(baseline.sends)) {
          baseline = { ...baseline, sends: Number(r.sends) - 1, receives: Number(r.receives ?? 0), lastSendId: sentNow }
          continue
        }
        if (Date.now() - start > 20000) {
          throw new DoubaoError("豆包没有把这条消息发出去", "doubao_ui")
        }
        continue
      }
      // 新回复同样按 message_id 判新鲜度，条数在虚拟列表下也可能不变。
      const fresh = (r.id && String(r.id) !== String(baseline.lastReceiveId ?? "")) || Number(r.receives) > Number(baseline.receives)
      if (!fresh) {
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

// sigKey 把一页的快照压成一行，用来判断「两次读到的还是不是同一个会话的同一版 DOM」。
export function sigKey(sig) {
  if (!sig) return ""
  return [sig.convId ?? "", sig.sends ?? 0, sig.receives ?? 0, sig.lastSendId ?? "", sig.lastReceiveId ?? ""].join("|")
}


function safeRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}
