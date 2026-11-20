/*
 * foreman 控制台：Lit 3 组件化前端。
 * 源码用裸 `lit` 导入，由 Vite 打包成 console/dist（`npm run build:console`），
 * 常驻服务直接下发 dist，不依赖 CDN，也不需要运行时 vendor 文件。
 * 组件都用 light DOM（createRenderRoot 返回 this），样式继续吃 style.css 的全局类。
 */
import { LitElement, html } from "lit"
import "./chat.js"

const STATE_LABEL = {
  planned: "已计划",
  running: "运行中",
  idle: "空闲",
  gone: "已失联",
  working: "进行中",
  done: "已完成",
  cleaned: "已清理",
  "pr-open": "已出 PR",
  "needs-human": "待人工",
  blocked: "阻塞",
  escalated: "已升级",
  failed: "失败",
  reset: "已重置",
  unknown: "未知",
}


const THEME_KEY = "foreman-theme"
const SIDEBAR_KEY = "foreman-sidebar-collapsed"
const pad2 = (n) => String(n).padStart(2, "0")
const emit = (host, name, detail) =>
  host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
const clockText = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
// 节点更新时间：ISO → 「MM-DD HH:MM」；已经是时钟串（HH:MM:SS）就原样用。
const stampText = (v) => {
  const raw = String(v ?? "").trim()
  if (!raw) return ""
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
// 账本状态兜底：CLI 派单（foreman run）不进服务的 workflow 实例，靠这层把节点位置推出来。
const STATE_STAGE = {
  planned: "pickup",
  working: "dispatch",
  "pr-open": "pr-open",
  done: "close",
  "needs-human": "develop",
  blocked: "develop",
  escalated: "conclude",
  failed: "develop",
}

/* ---------------- 主题切换 ---------------- */
class FmThemeSwitch extends LitElement {
  static properties = { mode: { type: String } }
  createRenderRoot() {
    return this
  }
  render() {
    const btn = (mode, label) => html`
      <button
        type="button"
        class=${this.mode === mode ? "is-active" : ""}
        aria-pressed=${this.mode === mode ? "true" : "false"}
        @click=${() => emit(this, "theme-set", { mode })}
      >${label}</button>`
    return html`
      <div class="theme-switch" role="group" aria-label="主题">
        ${btn("light", "亮")}${btn("dark", "暗")}${btn("system", "自动")}
      </div>`
  }
}

/* ---------------- 左侧导航 ---------------- */
function navIcon(id) {
  if (id === "chat") {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v13H9l-5 4V4zM8 9h8M8 13h5"/></svg>`
  }
  if (id === "inbox") {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v14H4zM4 14h4l2 3h4l2-3h4M12 4v7M9 8l3 3 3-3"/></svg>`
  }
  if (id === "outbox") {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v14H4zM4 14h4l2 3h4l2-3h4M12 11V4M9 7l3-3 3 3"/></svg>`
  }
  if (id === "tasks") {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>`
  }
  if (id === "schedules") {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2M8 2l-2 2M16 2l2 2"/></svg>`
  }
  return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>`
}

class FmSidebar extends LitElement {
  static properties = { view: { type: String }, collapsed: { type: Boolean } }
  createRenderRoot() {
    return this
  }
  render() {
    const views = [
      { id: "chat", label: "Chat" },
      { id: "inbox", label: "Inbox" },
      { id: "outbox", label: "Outbox" },
      { id: "tasks", label: "Tasks" },
      { id: "schedules", label: "设置" },
      { id: "operations", label: "操作日志" },
    ]
    return html`
      <aside class=${"sidebar" + (this.collapsed ? " is-collapsed" : "")} aria-label="控制台导航">
        <nav class="side-nav">
          ${views.map((v) => html`
            <button
              class=${"side-link" + (this.view === v.id ? " is-active" : "")}
              title=${v.label}
              aria-label=${v.label}
              aria-current=${this.view === v.id ? "page" : "false"}
              @click=${() => emit(this, "view-set", { view: v.id })}
            >
              <span class="side-icon">${navIcon(v.id)}</span>
              <span class="side-text">${v.label}</span>
            </button>`)}
        </nav>
        <button
          class="side-collapse"
          title=${this.collapsed ? "展开导航" : "折叠导航"}
          aria-label=${this.collapsed ? "展开导航" : "折叠导航"}
          aria-expanded=${this.collapsed ? "false" : "true"}
          @click=${() => emit(this, "sidebar-toggle")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d=${this.collapsed ? "m9 5 7 7-7 7M4 5l7 7-7 7" : "m15 5-7 7 7 7M20 5l-7 7 7 7"}/></svg>
          <span class="side-text">${this.collapsed ? "展开" : "折叠"}</span>
        </button>
      </aside>`
  }
}

/* ---------------- 顶栏 ---------------- */
class FmHead extends LitElement {
  static properties = {
    data: { attribute: false },
    mode: { type: String },
    error: { type: String },
    day: { type: String },
    today: { type: String },
    view: { type: String },
  }
  createRenderRoot() {
    return this
  }
  connectedCallback() {
    super.connectedCallback()
    this._clock = "--:--:--"
    this._timer = setInterval(() => {
      this._clock = clockText()
      this.requestUpdate()
    }, 1000)
  }
  disconnectedCallback() {
    clearInterval(this._timer)
    super.disconnectedCallback()
  }
  render() {
    const d = this.data
    const svc = d?.service || {}
    const prw = d?.prWatch || {}
    const historical = Boolean(this.day && this.day !== this.today)
    return html`
      <header class="topbar">
        <div class="brand">
          <span class=${"pulse" + (d && !svc.alive ? " is-off" : "")}></span>
          <span class="brand-text">FOREMAN<span class="thin">/CONSOLE</span></span>
        </div>
        <div class="meta">
          ${this.view === "tasks" ? html`<span class="meta-item day-wrap">
            <span class="day-label">看哪天</span>
            <input
              class="date-pick"
              type="date"
              max=${this.today || ""}
              .value=${this.day || this.today || ""}
              @change=${(e) => emit(this, "day-set", { day: e.target.value })}
            />
            <button
              class=${"ghost day-today" + (historical ? "" : " is-placeholder")}
              ?disabled=${!historical}
              aria-hidden=${historical ? "false" : "true"}
              tabindex=${historical ? "0" : "-1"}
              @click=${() => emit(this, "day-set", { day: "" })}
            >回到今天</button>
          </span>` : ""}
          <span class="meta-item mono">${this._clock}</span>
          <span class=${"pill " + (svc.alive ? "on" : "off")}>
            ${this.error ? this.error : svc.alive ? `服务 · 运行中 pid ${svc.pid}` : "服务 · 未运行"}
          </span>
          <span class=${"pill " + (prw.enabled ? "on" : "off")}>
            间隔 · ${prw.intervalSeconds ? `${prw.intervalSeconds}s` : "未开"}
          </span>
          <fm-theme-switch .mode=${this.mode}></fm-theme-switch>
        </div>
      </header>`
  }
}

/* ---------------- 指标卡 ---------------- */
class FmStats extends LitElement {
  static properties = { stats: { attribute: false }, scope: { type: String } }
  createRenderRoot() {
    return this
  }
  render() {
    const s = this.stats || {}
    const scope = this.scope || "今日"
    const cards = [
      { label: s.taskLabel || `${scope} 分配任务`, value: s.tasks, sub: `历史累计 ${s.historyTasks ?? 0} 单`, accent: "accent-cyan" },
      { label: s.workingLabel || "进行中", value: s.working, sub: s.unresolved === undefined ? `已出 PR ${s.prOpen ?? 0}` : `未收口 ${s.unresolved} · PR 待处理 ${s.prOpen ?? 0}`, accent: "accent-green" },
      { label: `${scope} PR`, value: s.prs, sub: `历史 ${s.historyPrs ?? 0} 条 · 新增 ${s.newPrs ?? 0}`, accent: "accent-cyan" },
    ]
    return html`
      <section class="stats">
        ${cards.map(
          (c) => html`
            <div class="stat ${c.accent}">
              <div class="stat-label">${c.label}</div>
              <div class="stat-value">${String(c.value ?? 0)}</div>
              <div class="stat-sub">${c.sub}</div>
            </div>`
        )}
      </section>`
  }
}

/* ---------------- 分页 ---------------- */
const PAGE_SIZE = 20
const pageSlice = (rows, requestedPage) => {
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1))
  return { page, total, rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) }
}
const pageNumbers = (page, pages) => {
  const wanted = [...new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < wanted.length; i++) {
    if (i > 0 && wanted[i] - wanted[i - 1] > 1) out.push("…")
    out.push(wanted[i])
  }
  return out
}

class FmPagination extends LitElement {
  static properties = { page: { type: Number }, total: { type: Number }, pageSize: { type: Number }, scope: { type: String } }
  createRenderRoot() {
    return this
  }
  go(page) {
    emit(this, "page-set", { scope: this.scope, page })
  }
  render() {
    const total = Math.max(0, Number(this.total) || 0)
    if (!total) return html``
    const size = Math.max(1, Number(this.pageSize) || PAGE_SIZE)
    const pages = Math.max(1, Math.ceil(total / size))
    const page = Math.min(pages, Math.max(1, Number(this.page) || 1))
    const start = (page - 1) * size + 1
    const end = Math.min(total, page * size)
    return html`
      <div class="panel-foot pagination">
        <span>第 ${start}–${end} 条 · 共 ${total} 条</span>
        <div class="page-buttons" aria-label="分页">
          <button class="ghost page-btn" ?disabled=${page <= 1} @click=${() => this.go(page - 1)}>上一页</button>
          ${pageNumbers(page, pages).map((item) => item === "…"
            ? html`<span class="page-ellipsis">…</span>`
            : html`<button
                class=${"ghost page-btn" + (item === page ? " is-active" : "")}
                aria-current=${item === page ? "page" : "false"}
                @click=${() => this.go(item)}
              >${item}</button>`)}
          <button class="ghost page-btn" ?disabled=${page >= pages} @click=${() => this.go(page + 1)}>下一页</button>
        </div>
      </div>`
  }
}

/* ---------------- 今日任务（可展开看每个节点的详情） ---------------- */
class FmTasks extends LitElement {
  static properties = {
    tasks: { attribute: false },
    sessions: { attribute: false },
    summary: { attribute: false },
    isToday: { type: Boolean },
    nodes: { attribute: false },
    runs: { attribute: false },
    workflows: { attribute: false },
    scope: { type: String },
    // tab：today（今日/某天已分配）| pending（待分配，可点接单）
    tab: { type: String },
    candidates: { attribute: false },
    candInfo: { attribute: false },
    candBusy: { type: String },
    candError: { type: String },
    candNote: { type: String },
    completeBusy: { type: String },
    completeNote: { type: String },
    completeError: { type: String },
    page: { type: Number },
    candidatePage: { type: Number },
  }
  createRenderRoot() {
    return this
  }
  toggle(key) {
    this.openKey = this.openKey === key ? "" : key
    this.requestUpdate()
  }
  // 一张单的节点时间线：run 当前停在哪，前序节点算走过、后序算待跑。
  detail(t) {
    const key = `${t.repo}#${t.number}`
    // 同一张单可能同时有「自有工单」与「他人 PR」两条流程的实例（比如自己的 PR 被别人也扫过）：
    // 优先挑在跑的，其次挑自有工单那条，最后才退回别的，避免把自己的单显示成别人 PR 的流程。
    const matches = (this.runs || []).filter((r) => r.key === key)
    const live =
      matches.find((r) => r.status === "running" && r.workflow === "own") ||
      matches.find((r) => r.workflow === "own") ||
      matches.find((r) => r.status === "running") ||
      matches[0]
    // CLI 派单（foreman run）不进服务进程，没有 workflow 实例：按账本状态推一个，
    // 否则详情会整排「待跑」，看着像这条单压根没开始。
    const derived = live
      ? null
      : STATE_STAGE[t.state]
        ? { workflow: "own", stage: STATE_STAGE[t.state], status: t.state === "done" ? "done" : "running", derived: true }
        : null
    const run = live ?? derived
    const flow = (this.workflows || []).find((w) => w.id === (run?.workflow ?? "own"))
    const stages = flow?.stages ?? []
    const nodes = this.nodes || []
    const at = stages.findIndex((s) => s.stage === (run?.stage ?? ""))
    return html`
      <tr class="detail-row">
        <td colspan="7">
          <div class="task-detail">
            <div class="task-detail-head">
              <span class="hint">${flow ? `${flow.name} · ${flow.description}` : "这条工单还没进 workflow"}</span>
              <span class=${"badge " + (run?.status === "done" ? "done" : "working")}>${run
                ? (run.status === "done" ? "流程已完成" : `当前节点 ${run.stage || "—"}${derived ? "（按账本状态推算）" : ""}`)
                : "未开始"}</span>
            </div>
            ${stages.length
              ? html`<ol class="wf-nodes compact">
                  ${stages.map((st, i) => {
                    const n = nodes.find((x) => x.stage === st.stage) || {}
                    const state = at < 0 ? "pending" : i < at ? "passed" : i === at ? "current" : "pending"
                    const label = state === "passed" ? "已走过" : state === "current" ? "当前" : "待跑"
                    // 只有「当前节点」能暂停：已走过的、还没跑到的（待跑）都不给按钮。
                    const canToggle = !!run && run.status !== "done" && state === "current"
                    return html`
                      <li class=${"wf-node is-" + state}>
                        <div class="wf-node-main">
                          <span class="wf-stage">${st.stage}</span>
                          <span class=${"badge " + (state === "current" ? "working" : state === "passed" ? "done" : "planned")}>${label}</span>
                          ${state === "pending"
                            ? "" // 还没跑到的节点没有更新时间：不占位、不显示
                            : (() => {
                                const own = run?.stageAt?.[st.stage] ?? ""
                                const time = own || n.lastAt || ""
                                const kind = own
                                  ? "本单在这个节点的更新时间"
                                  : n.lastAt
                                    ? "这个节点最近一次执行时间（不一定是本单）"
                                    : "本单最近更新时间"
                                const text = stampText(time) || t.updatedAtClock || "—"
                                return html`<span class="wf-time" title=${kind}><span class="k">更新</span> ${text}</span>`
                              })()}
                          ${n.paused ? html`<span class="badge failed">已暂停</span>` : ""}
                        </div>
                        <div class="wf-node-sub">${st.description}</div>
                        ${canToggle
                          ? html`<button class="ghost wf-btn" @click=${() => emit(this, "node-toggle", { stage: st.stage, paused: !n.paused })}>
                              ${n.paused ? "继续" : "暂停"}
                            </button>`
                          : ""}
                      </li>`
                  })}
                </ol>`
              : html`<div class="hint">还没有节点记录：这条单还没被分配到 workflow。</div>`}
          </div>
        </td>
      </tr>`
  }
  // 待分配：全部 open 工单，只做账本去重；标签原样展示，过滤规则仍只作用于自动巡检。
  pendingView() {
    const items = this.candidates || []
    const paged = pageSlice(items, this.candidatePage)
    const info = this.candInfo || {}
    const cap = info.capacity || {}
    const busy = this.candBusy || ""
    const BUCKET = {
      mine: ["done", "我的"],
      unassigned: ["working", "无人认领"],
      others: ["self", "他人认领"],
    }
    const note = this.candError
      ? html`<div class="panel-note is-error">${this.candError}</div>`
      : this.candNote
        ? html`<div class="panel-note is-ok">${this.candNote}</div>`
        : ""
    if (!items.length) {
      return html`${note}
        <div class="empty">
          <div class="empty-title">${busy === "loading" ? "正在拉待分配队列…" : "队列里没有待分配的任务"}</div>
          <div class="empty-sub">列出配置仓库里所有 open 工单；账本里已处理、在跑、已交编排的自动排除</div>
        </div>`
    }
    return html`${note}
      <div class="table-wrap">
        <table class="tasks">
          <thead>
            <tr>
              <th class="col-id">工单</th>
              <th>标题</th>
              <th>标签</th>
              <th class="col-state">归属</th>
              <th class="col-branch">作者</th>
              <th class="col-time">创建</th>
              <th class="col-detail">接单</th>
            </tr>
          </thead>
          <tbody>
            ${paged.rows.map((c) => {
              const key = `${c.repo}#${c.number}`
              const [cls, label] = BUCKET[c.bucket] || ["self", "他人认领"]
              const labels = (Array.isArray(c.labels) ? c.labels : [])
                .map((tag) => String(typeof tag === "string" ? tag : tag?.name ?? "").trim())
                .filter(Boolean)
              return html`
                <tr>
                  <td class="id-cell">
                    <a class="id-link" href=${c.url} target="_blank" rel="noopener"
                      ><span class="repo">${c.repo}#</span><span>${c.number}</span></a>
                  </td>
                  <td class="title-cell" title=${c.title || ""}>${c.title || "（无标题）"}</td>
                  <td class="labels-cell">
                    ${labels.length
                      ? html`<div class="candidate-labels" aria-label="工单标签">
                          ${labels.map((tag) => html`<span class=${"candidate-label" + (tag === "ready-for-agent" ? " is-ready" : "")}>${tag}</span>`)}
                        </div>`
                      : "—"}
                  </td>
                  <td><span class=${"badge " + cls}>${label}</span></td>
                  <td class="branch-cell" title=${c.author || ""}>${c.author || "—"}</td>
                  <td class="time-cell">${stampText(c.createdAt) || "—"}</td>
                  <td class="detail-cell">
                    <button class="ghost" ?disabled=${busy === key} @click=${() => emit(this, "candidate-pick", { repo: c.repo, number: c.number })}>
                      ${busy === key ? "接单中…" : "接单"}
                    </button>
                  </td>
                </tr>`
            })}
          </tbody>
        </table>
      </div>
      <fm-pagination scope="candidates" .page=${paged.page} .total=${paged.total} .pageSize=${PAGE_SIZE}></fm-pagination>
      <div class="panel-foot pagination-note">
        ${(info.total || items.length) > items.length
          ? `共 ${info.total} 条待分配 · 按「我的 → 无人认领 → 他人认领」只显示前 ${items.length} 条 · `
          : ""}在跑 ${cap.inflight ?? 0}/${cap.maxRunning ?? "?"} · 手动接单不看自动接单开关 · 带 needs-info 类标签的走决策单（不监听）
      </div>`
  }
  sessionTask(node) {
    return (this.tasks || []).find((t) => t.key === node.issueKey) || null
  }
  sessionRow(node, depth = 0, connector = "") {
    const task = this.sessionTask(node)
    const issueKeys = [...new Set([node.issueKey, ...Object.keys(node.issueStates || {})].filter(Boolean))]
    const stateClass = { running: "working", idle: "planned", gone: "failed", unknown: "unknown" }[node.state] || "unknown"
    const detailKey = task ? `${task.repo}#${task.number}` : ""
    return html`
      <tr class="session-row">
        <td class="session-cell" title=${node.name || ""}>
          <span class="session-name" style=${`padding-left: ${depth * 20}px`}>
            <span class="tree-connector">${connector}</span><span>${node.name || "未命名会话"}</span>
          </span>
        </td>
        <td class="session-role">${node.roleName || "—"}</td>
        <td><span class=${"badge " + stateClass}>${STATE_LABEL[node.state] || node.state}</span></td>
        <td class="branch-cell" title=${issueKeys.join(", ")}>${issueKeys.length ? issueKeys.join(", ") : "—"}</td>
        <td>${node.issueState ? html`<span class=${"badge " + node.issueState}>${STATE_LABEL[node.issueState] || node.issueState}</span>` : "—"}</td>
        <td class="branch-cell">${node.prKey ? `${node.prKey} · ${node.prMerged ? "已合并" : "待合并"}` : "—"}</td>
        <td class="detail-cell">
          ${task
            ? html`<button class="ghost" @click=${() => this.toggle(detailKey)}>${this.openKey === detailKey ? "收起" : "详情"}</button>
                ${task.state === "pr-open"
                  ? html`<button
                      class="ghost session-complete"
                      title="核对远端 PR 已合并后，将工单置为已完成并执行既有清理"
                      ?disabled=${this.completeBusy !== ""}
                      @click=${() => emit(this, "task-complete", { repo: task.repo, number: task.number })}
                    >${this.completeBusy === detailKey ? "完成中…" : "手动完成"}</button>`
                  : ""}`
            : "—"}
        </td>
      </tr>
      ${detailKey && this.openKey === detailKey ? this.detail(task) : ""}
      ${(node.children || []).map((child, index, children) =>
        this.sessionRow(child, depth + 1, index === children.length - 1 ? "└─ " : "├─ "))}`
  }
  sessionsView() {
    const roots = this.sessions || []
    const paged = pageSlice(roots, this.page)
    if (!roots.length) {
      return html`<div class="empty">
        <div class="empty-title">当前还没有分配会话</div>
        <div class="empty-sub">编排、编码、补派与合并会话会按父子关系显示在这里</div>
      </div>`
    }
    return html`
      <div class="table-wrap">
        <table class="tasks session-table">
          <thead><tr>
            <th class="col-session">会话</th>
            <th class="col-role">角色</th>
            <th class="col-state">真实状态</th>
            <th>工单</th>
            <th class="col-issue-state">工单状态</th>
            <th class="col-pr">PR</th>
            <th class="col-detail">详情</th>
          </tr></thead>
          <tbody>${paged.rows.map((node) => this.sessionRow(node))}</tbody>
        </table>
      </div>
      <fm-pagination scope="tasks" .page=${paged.page} .total=${paged.total} .pageSize=${PAGE_SIZE}></fm-pagination>`
  }
  render() {
    const rows = this.tasks || []
    const sessionMode = this.isToday === true && Array.isArray(this.sessions)
    const summary = this.summary || {}
    const paged = pageSlice(rows, this.page)
    const scope = this.scope || "今日"
    const tab = this.tab === "pending" ? "pending" : "today"
    const pending = (this.candidates || []).length
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>Tasks</h2>
          <div class="tabs" role="tablist">
            <button
              class=${"tab" + (tab === "today" ? " is-active" : "")}
              role="tab"
              aria-selected=${tab === "today" ? "true" : "false"}
              @click=${() => emit(this, "task-tab", { tab: "today" })}
            >${scope}任务</button>
            <button
              class=${"tab" + (tab === "pending" ? " is-active" : "")}
              role="tab"
              aria-selected=${tab === "pending" ? "true" : "false"}
              @click=${() => emit(this, "task-tab", { tab: "pending" })}
            >待分配任务${pending ? ` ${pending}` : ""}</button>
          </div>
          <div class="panel-side">
            ${tab === "pending"
              ? html`<button class="ghost" ?disabled=${this.candBusy === "loading"} @click=${() => emit(this, "candidates-refresh")}>
                  ${this.candBusy === "loading" ? "刷新中…" : "刷新"}
                </button>`
              : html`<span class="hint">${sessionMode
                  ? `${summary.sessions ?? 0} 会话 · 真实运行 ${summary.runningWorkers ?? 0} · 未收口 ${summary.unresolvedIssues ?? 0}`
                  : rows.length ? `${rows.length} 条 · 点「详情」看每个节点` : "暂无"}</span>`}
          </div>
        </div>
        ${tab === "today" && this.completeError ? html`<div class="note error" role="alert">${this.completeError}</div>` : ""}
        ${tab === "today" && this.completeNote ? html`<div class="note" role="status">${this.completeNote}</div>` : ""}
        ${tab === "pending" ? this.pendingView() : sessionMode ? this.sessionsView() : rows.length
          ? html`
              <div class="table-wrap">
                <table class="tasks">
                  <thead>
                    <tr>
                      <th class="col-id">工单</th>
                      <th>标题</th>
                      <th class="col-state">状态</th>
                      <th class="col-branch">分支</th>
                      <th class="col-try">尝试</th>
                      <th class="col-time">更新</th>
                      <th class="col-detail">详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${paged.rows.map((t) => {
                      const key = `${t.repo}#${t.number}`
                      return html`
                        <tr>
                          <td class="id-cell">
                            ${t.url
                              ? html`<a class="id-link" href=${t.url} target="_blank" rel="noopener"
                                  ><span class="repo">${t.repo}#</span><span>${t.number}</span></a>`
                              : html`<span class="repo">${t.repo}#</span><span>${t.number}</span>`}
                          </td>
                          <td class="title-cell" title=${t.title || ""}>${t.title || "（无标题）"}</td>
                          <td><span class="badge ${t.state}">${STATE_LABEL[t.state] || t.state}</span></td>
                          <td class="branch-cell" title=${t.branch || ""}>${t.branch || "—"}</td>
                          <td class="try-cell">${t.attempts ? `#${t.attempts}` : "—"}</td>
                          <td class="time-cell">${t.updatedAtClock || "—"}</td>
                          <td class="detail-cell">
                            <button class="ghost" @click=${() => this.toggle(key)}>${this.openKey === key ? "收起" : "详情"}</button>
                            ${t.state === "pr-open"
                              ? html`<button
                                  class="ghost"
                                  style="margin-left: 6px"
                                  title="核对远端 PR 已合并后，将工单置为已完成并执行既有清理"
                                  ?disabled=${this.completeBusy !== ""}
                                  @click=${() => emit(this, "task-complete", { repo: t.repo, number: t.number })}
                                >${this.completeBusy === key ? "完成中…" : "手动完成"}</button>`
                              : ""}
                          </td>
                        </tr>
                        ${this.openKey === key ? this.detail(t) : ""}`
                    })}
                  </tbody>
                </table>
              </div>
              <fm-pagination scope="tasks" .page=${paged.page} .total=${paged.total} .pageSize=${PAGE_SIZE}></fm-pagination>`
          : html`
              <div class="empty">
                <div class="empty-title">今天还没有分配到任务</div>
                <div class="empty-sub">foreman run 派活后会出现在这里</div>
              </div>`}
      </section>`
  }
}

/* ---------------- Inbox / Outbox 持久队列 ---------------- */
const QUEUE_STATUS_LABEL = {
  pending: "待处理",
  processing: "处理中",
  done: "已完成",
  dropped: "已丢弃",
  sent: "已发送",
  failed: "失败",
}
const compactJson = (value) => {
  try { return JSON.stringify(value ?? {}) } catch { return String(value ?? "") }
}
const prettyJson = (value) => {
  try { return JSON.stringify(value ?? {}, null, 2) } catch { return String(value ?? "") }
}
const queueSummary = (kind, row) => {
  const payload = row.payload || {}
  if (kind === "inbox") return row.text || payload.title || payload.text || payload.message || payload.subject || compactJson(payload)
  return payload.subject || payload.text || payload.markdown || payload.body || compactJson(payload)
}

class FmQueue extends LitElement {
  static properties = {
    kind: { type: String },
    rows: { attribute: false },
    counts: { attribute: false },
    filter: { type: String },
    busy: { type: String },
    error: { type: String },
    page: { type: Number },
    pageSize: { type: Number },
    total: { type: Number },
  }
  createRenderRoot() {
    return this
  }
  toggle(id) {
    this.openKey = this.openKey === id ? null : id
    this.requestUpdate()
  }
  detail(row) {
    return html`<tr class="detail-row">
      <td colspan="7">
        <div class="queue-detail">
          ${row.lastError ? html`<div class="queue-error">最近错误：${row.lastError}</div>` : ""}
          ${row.reason ? html`<div class="hint">原因：${row.reason}</div>` : ""}
          <div class="queue-times">
            <span>创建 ${stampText(row.createdAt) || "—"}</span>
            <span>可执行 ${stampText(row.availableAt) || "—"}</span>
            ${row.sentAt ? html`<span>发送 ${stampText(row.sentAt)}</span>` : ""}
          </div>
          <pre class="queue-payload">${prettyJson(row.payload)}</pre>
          ${this.kind === "outbox" && Object.keys(row.result || {}).length
            ? html`<div class="hint">发送结果</div><pre class="queue-payload">${prettyJson(row.result)}</pre>`
            : ""}
        </div>
      </td>
    </tr>`
  }
  render() {
    const kind = this.kind === "outbox" ? "outbox" : "inbox"
    const title = kind === "outbox" ? "Outbox" : "Inbox"
    const rows = this.rows || []
    const current = this.filter || "all"
    const filters = kind === "outbox"
      ? ["all", "pending", "processing", "sent", "failed"]
      : ["all", "pending", "processing", "done", "dropped"]
    const labels = { all: "全部", ...QUEUE_STATUS_LABEL }
    const counts = this.counts || {}
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0)
    return html`
      <section class="panel">
        <div class="panel-head queue-head">
          <div>
            <h2>${title}</h2>
            <div class="hint">${kind === "outbox" ? "外部通知与邮件的持久外发队列" : "调度、巡检与任务更新的持久事件队列"}</div>
          </div>
          <div class="panel-side">
            <div class="tabs queue-tabs" role="tablist" aria-label="${title} 状态筛选">
              ${filters.map((status) => html`
                <button
                  class=${"tab" + (current === status ? " is-active" : "")}
                  role="tab"
                  aria-selected=${current === status ? "true" : "false"}
                  @click=${() => emit(this, "queue-filter", { queue: kind, status })}
                >${labels[status]} ${status === "all" ? total : Number(counts[status] || 0)}</button>`)}
            </div>
            <button class="ghost" ?disabled=${this.busy === "loading"} @click=${() => emit(this, "queue-refresh", { queue: kind })}>
              ${this.busy === "loading" ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>
        ${this.error ? html`<div class="panel-note is-error" role="alert">${this.error}</div>` : ""}
        ${rows.length ? html`
          <div class="table-wrap">
            <table class="tasks queue-table">
              <thead><tr>
                <th class="col-id">ID</th>
                <th class="col-kind">${kind === "outbox" ? "通道" : "类型"}</th>
                <th>内容</th>
                <th class="col-state">状态</th>
                <th class="col-try">尝试</th>
                <th class="col-time">更新</th>
                <th class="col-detail">详情</th>
              </tr></thead>
              <tbody>
                ${rows.map((row) => html`
                  <tr>
                    <td class="id-cell">#${row.id}</td>
                    <td class="branch-cell" title=${kind === "outbox" ? row.channel : row.kind}>${kind === "outbox" ? row.channel : row.payload?.type || row.kind}</td>
                    <td class="title-cell" title=${queueSummary(kind, row)}>${queueSummary(kind, row) || "—"}</td>
                    <td><span class=${"badge " + (row.status === "processing" ? "working" : row.status === "sent" ? "done" : row.status)}>${QUEUE_STATUS_LABEL[row.status] || row.status}</span></td>
                    <td class="try-cell">${row.attempts || 0}${kind === "outbox" ? `/${row.maxAttempts || "—"}` : ""}</td>
                    <td class="time-cell">${stampText(row.updatedAt) || "—"}</td>
                    <td class="detail-cell"><button class="ghost" @click=${() => this.toggle(row.id)}>${this.openKey === row.id ? "收起" : "详情"}</button></td>
                  </tr>
                  ${this.openKey === row.id ? this.detail(row) : ""}`)}
              </tbody>
            </table>
          </div>
          <fm-pagination
            scope=${kind}
            .page=${this.page || 1}
            .total=${this.total ?? rows.length}
            .pageSize=${this.pageSize || PAGE_SIZE}
          ></fm-pagination>
          <div class="panel-foot pagination-note">每 15 秒自动刷新 · 点击「详情」查看完整 payload</div>`
          : html`<div class="empty">
              <div class="empty-title">${this.busy === "loading" ? `正在读取 ${title}…` : "当前分类没有记录"}</div>
              <div class="empty-sub">${kind === "outbox" ? "外发意图入队后会出现在这里" : "持久事件写入后会出现在这里"}</div>
            </div>`}
      </section>`
  }
}

/* ---------------- 定时任务 ---------------- */
// 上次结果可能是字符串，也可能是 { dispatched, handled } 这种对象：别在页面上渲染成 [object Object]。
const resultText = (v) => {
  if (!v) return ""
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  if (typeof v === "object") {
    if (v.skipped) return `跳过 · ${SKIP_LABEL[v.skipped] || v.skipped}`
    if (Number.isFinite(Number(v.dispatched))) return `派出 ${Number(v.dispatched)} 条`
    return ""
  }
  return String(v)
}
const SKIP_LABEL = {
  disabled: "这项没开",
  "off-hours": "不在工作时间",
  busy: "上一轮还没跑完",
  locked: "另一个进程正占着锁",
  "slots-full": "在跑名额已满",
  "node-paused": "节点已暂停",
  "window-busy": "被监听的会话还在跑",
}

const WEEK_DAYS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
]

class FmSchedules extends LitElement {
  static properties = {
    schedules: { attribute: false },
    workHours: { attribute: false },
    busy: { type: String },
    error: { type: String },
    note: { type: String },
    screen: { type: String },
    selectedId: { type: String },
    formError: { type: String },
  }
  constructor() {
    super()
    this.screen = "list"
    this.selectedId = ""
    this.formError = ""
  }
  createRenderRoot() {
    return this
  }
  selected() {
    return (this.schedules || []).find((item) => item.id === this.selectedId) || null
  }
  showList() {
    this.screen = "list"
    this.selectedId = ""
    this.formError = ""
  }
  showDetail(id) {
    this.selectedId = id
    this.screen = "detail"
    this.formError = ""
  }
  showEdit(id) {
    this.selectedId = id
    this.screen = "edit"
    this.formError = ""
  }
  save() {
    const schedule = this.selected()
    if (!schedule) return
    const value = (name) => this.querySelector(`[data-schedule-field="${name}"]`)
    const patch = { enabled: Boolean(value("enabled")?.checked) }
    if (schedule.id === "workHours") {
      patch.days = [...this.querySelectorAll("[data-work-days]:checked")].map((input) => Number(input.value))
      patch.start = value("start")?.value || ""
      patch.end = value("end")?.value || ""
    } else {
      patch.cron = value("cron")?.value.trim() || ""
    }
    if (schedule.script) {
      let args
      try {
        args = JSON.parse(value("args")?.value || "{}")
      } catch (error) {
        this.formError = `脚本参数不是合法 JSON：${error.message}`
        return
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        this.formError = "脚本参数必须是 JSON 对象"
        return
      }
      patch.script = {
        path: value("script-path")?.value.trim() || "",
        exportName: value("script-export")?.value.trim() || "",
        args,
      }
    }
    if (schedule.agent) {
      patch.agent = { prompt: value("agent-prompt")?.value ?? "" }
      // 只有自定义 Agent 任务才有 cwd；内置（如 dreaming）不带这个字段，别顺手改掉。
      if (schedule.agent.custom) patch.agent.cwd = value("agent-cwd")?.value.trim() ?? ""
    }
    this.formError = ""
    emit(this, "schedule-save", { id: schedule.id, patch: { [schedule.id]: patch } })
  }
  status(schedule) {
    return html`<span class=${"badge " + (schedule.enabled ? "notified" : "self")}>${schedule.enabled ? "运行中" : "已停止"}</span>`
  }
  executorBadge(schedule) {
    if (!schedule.executor) return html`<span class="badge self">条件</span>`
    return html`<span class="badge self">${schedule.executor === "agent" ? "Agent" : "脚本"}</span>`
  }
  messages() {
    return html`
      ${this.error || this.formError ? html`<div class="sched-error">${this.formError || this.error}</div>` : ""}
      ${this.note ? html`<div class="sched-note schedule-message">${this.note}</div>` : ""}
    `
  }
  renderList(rows) {
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>设置</h2>
          <div class="panel-side"><span class="hint">列表只读；进入详情或编辑后管理任务</span></div>
        </div>
        ${this.messages()}
        <ul class="sched-list">
          ${rows.map((s) => html`
            <li class="sched">
              <div class="sched-main">
                <span class=${"dot " + (s.enabled ? "on" : "off")}></span>
                <span class="sched-name">${s.label}</span>
                ${this.status(s)}
                ${this.executorBadge(s)}
                <span class="sched-detail">${s.detail || ""}</span>
              </div>
              <div class="sched-meta">
                ${s.cron !== undefined ? html`<span class="pr-note">cron ${s.cron}</span>` : ""}
                ${s.cwd ? html`<span class="pr-note" title=${s.cwd}>cwd ${s.cwd}</span>` : ""}
                ${s.nextAt ? html`<span class="pr-note">下次 ${s.nextAt}</span>` : ""}
                ${s.lastAt ? html`<span class="pr-note">上次 ${s.lastAt}</span>` : ""}
                ${s.count ? html`<span class="pr-note">已跑 ${s.count} 轮</span>` : ""}
              </div>
              <div class="sched-acts">
                <button class="ghost" @click=${() => this.showDetail(s.id)}>详情</button>
                <button class="ghost" @click=${() => this.showEdit(s.id)}>编辑</button>
              </div>
            </li>`)}
          ${rows.length ? "" : html`<li class="empty"><div class="empty-title">暂时取不到设置项</div></li>`}
        </ul>
      </section>`
  }
  renderScript(script, editing) {
    if (editing) {
      return html`
        <section class="schedule-config-section">
          <h3>脚本配置</h3>
          <label class="schedule-field">
            <span>脚本路径</span>
            <input data-schedule-field="script-path" required spellcheck="false" .value=${script.path} />
            <small>相对 Foreman 包目录，或填写绝对路径</small>
          </label>
          <label class="schedule-field">
            <span>导出函数</span>
            <input data-schedule-field="script-export" required spellcheck="false" .value=${script.exportName} />
          </label>
          <label class="schedule-field">
            <span>脚本参数（JSON 对象）</span>
            <textarea data-schedule-field="args" rows="7" spellcheck="false" .value=${JSON.stringify(script.args || {}, null, 2)}></textarea>
          </label>
        </section>`
    }
    return html`
      <section class="schedule-config-section">
        <h3>脚本配置</h3>
        <dl class="schedule-definition">
          <div><dt>脚本路径</dt><dd><code>${script.path}</code></dd></div>
          <div><dt>导出函数</dt><dd><code>${script.exportName}</code></dd></div>
        </dl>
        <span class="schedule-field-label">脚本参数</span>
        <pre class="schedule-prompt">${JSON.stringify(script.args || {}, null, 2)}</pre>
      </section>`
  }
  renderAgent(agent, editing) {
    return html`
      <section class="schedule-config-section">
        <h3>Agent 提示词</h3>
        <p class="hint">${agent.custom ? "当前使用自定义提示词；清空后保存可恢复内置提示词。" : "当前使用内置提示词。"} 提示词在新建路由 Agent 会话时使用。</p>
        ${editing
          ? html`<textarea class="schedule-agent-input" data-schedule-field="agent-prompt" rows="20" spellcheck="false" .value=${agent.prompt}></textarea>`
          : html`<pre class="schedule-prompt">${agent.prompt}</pre>`}
      </section>
      ${agent.custom ? html`<section class="schedule-config-section">
        <h3>工作目录</h3>
        ${editing
          ? html`
            <label class="schedule-field">
              <span>cwd</span>
              <input data-schedule-field="agent-cwd" spellcheck="false" .value=${agent.cwd || ""} placeholder="留空 = 脚本所在位置（foreman 包目录）" />
              <small>到点投递的提示词会写明这个目录；记日志、写文件按它定位。留空即用默认。</small>
            </label>`
          : html`<dl class="schedule-definition">
              <div><dt>工作目录</dt><dd><code>${agent.cwd || "脚本所在位置（默认）"}</code></dd></div>
            </dl>`}
      </section>` : ""}`
  }
  renderDetail(schedule) {
    const result = resultText(schedule.lastResult) || (schedule.lastResult && typeof schedule.lastResult === "object" ? JSON.stringify(schedule.lastResult) : "")
    return html`
      <section class="panel">
        <div class="panel-head">
          <div class="schedule-title">
            <button class="ghost" @click=${() => this.showList()}>← 返回列表</button>
            <h2>${schedule.label} · 详情</h2>
            ${this.status(schedule)}${this.executorBadge(schedule)}
          </div>
          <div class="panel-side">
            ${schedule.runnable ? html`<button class="ghost" ?disabled=${this.busy !== "" || schedule.running} @click=${() => emit(this, "schedule-run", { id: schedule.id })}>${this.busy === `run-${schedule.id}` ? "执行中…" : schedule.runLabel || "立即执行"}</button>` : ""}
            <button class="ghost" @click=${() => this.showEdit(schedule.id)}>编辑</button>
          </div>
        </div>
        ${this.messages()}
        <div class="schedule-detail-body">
          <p class="schedule-description">${schedule.detail || ""}</p>
          <dl class="schedule-definition">
            <div><dt>任务 ID</dt><dd><code>${schedule.id}</code></dd></div>
            ${schedule.cron !== undefined ? html`<div><dt>Cron</dt><dd><code>${schedule.cron}</code></dd></div>` : ""}
            <div><dt>下次执行</dt><dd>${schedule.nextAt || "未排期"}</dd></div>
            <div><dt>上次执行</dt><dd>${schedule.lastAt || "暂无"}</dd></div>
            <div><dt>执行次数</dt><dd>${Number(schedule.count || 0)}</dd></div>
            ${result ? html`<div><dt>最近结果</dt><dd>${result}</dd></div>` : ""}
          </dl>
          ${schedule.script ? this.renderScript(schedule.script, false) : ""}
          ${schedule.agent ? this.renderAgent(schedule.agent, false) : ""}
        </div>
      </section>`
  }
  renderEdit(schedule) {
    return html`
      <section class="panel">
        <div class="panel-head">
          <div class="schedule-title">
            <button class="ghost" @click=${() => this.showDetail(schedule.id)}>← 返回详情</button>
            <h2>${schedule.label} · 编辑</h2>
            ${this.executorBadge(schedule)}
          </div>
        </div>
        ${this.messages()}
        <form class="schedule-edit-form" @submit=${(event) => { event.preventDefault(); this.save() }}>
          <label class="schedule-enabled">
            <input type="checkbox" data-schedule-field="enabled" .checked=${schedule.enabled} />
            <span>启用这项设置</span>
          </label>
          ${schedule.id === "workHours" ? html`
            <section class="schedule-config-section">
              <h3>工作时间</h3>
              <div class="work-days-editor">
                <span class="work-days-label">工作日</span>
                <div class="work-day-options">
                  ${WEEK_DAYS.map((day) => html`
                    <label class="work-day-option">
                      <input type="checkbox" data-work-days value=${day.value} .checked=${(this.workHours?.days ?? [1, 2, 3, 4, 5]).includes(day.value)} />
                      <span>${day.label}</span>
                    </label>`)}
                </div>
              </div>
              <div class="work-hours-form">
                <label class="time-field"><span>开始时间</span><input type="time" data-schedule-field="start" required step="60" .value=${this.workHours?.start || "08:30"} /></label>
                <span class="time-separator">至</span>
                <label class="time-field"><span>结束时间</span><input type="time" data-schedule-field="end" required step="60" .value=${this.workHours?.end || "18:30"} /></label>
              </div>
            </section>` : html`
            <label class="schedule-field">
              <span>Cron</span>
              <input class="cron-input" data-schedule-field="cron" required spellcheck="false" .value=${schedule.cron || ""} placeholder="*/30 * * * *" />
              <small>格式：分 时 日 月 周；也支持第 6 段秒</small>
            </label>`}
          ${schedule.script ? this.renderScript(schedule.script, true) : ""}
          ${schedule.agent ? this.renderAgent(schedule.agent, true) : ""}
          <div class="schedule-form-actions">
            <button type="button" class="ghost" @click=${() => this.showDetail(schedule.id)}>取消</button>
            <button type="submit" class="ghost" ?disabled=${this.busy !== ""}>${this.busy === schedule.id ? "保存中…" : "保存"}</button>
          </div>
        </form>
      </section>`
  }
  render() {
    const rows = this.schedules || []
    const selected = this.selected()
    if (this.screen === "detail" && selected) return this.renderDetail(selected)
    if (this.screen === "edit" && selected) return this.renderEdit(selected)
    return this.renderList(rows)
  }
}

/* ---------------- 操作日志 ---------------- */
class FmOperations extends LitElement {
  static properties = { operations: { attribute: false }, filter: { type: String } }
  createRenderRoot() {
    return this
  }
  render() {
    const all = this.operations || []
    const current = this.filter || "all"
    const rows = current === "all" ? all : all.filter((o) => o.status === current)
    const filters = [
      ["all", "全部"],
      ["running", "进行中"],
      ["success", "成功"],
      ["failed", "失败"],
      ["interrupted", "已中断"],
    ]
    const statusLabel = { running: "进行中", success: "成功", failed: "失败", interrupted: "已中断" }
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>操作日志</h2>
          <div class="panel-side">
            <span class="hint">派单、通知、合并、清理与归档；每 15 秒刷新</span>
            <div class="tabs">
              ${filters.map(([id, label]) => html`
                <button class=${"tab " + (current === id ? "is-active" : "")}
                  @click=${() => emit(this, "operation-filter", { filter: id })}
                >${label} ${id === "all" ? all.length : all.filter((o) => o.status === id).length}</button>`)}
            </div>
          </div>
        </div>
        ${rows.length ? html`
          <ul class="operation-list">
            ${rows.map((o) => html`
              <li class=${"operation " + o.status}>
                <span class="op-time mono">${o.startedAtClock || "—"}</span>
                <span class=${"dot " + (o.status === "running" ? "on" : o.status === "failed" || o.status === "interrupted" ? "off" : "done")}></span>
                <div class="op-main">
                  <div class="op-title">${o.status === "running" ? "正在" : ""}${o.title}</div>
                  <div class="op-detail">${o.detail || "等待结果"}</div>
                  ${o.key ? html`<div class="op-key mono">${o.key}</div>` : ""}
                </div>
                <div class="op-result">
                  <span class=${"badge op-" + o.status}>${statusLabel[o.status] || o.status}</span>
                  <span class="pr-note">${o.finishedAtClock ? `结束 ${o.finishedAtClock}` : "仍在执行"}</span>
                </div>
              </li>`)}
          </ul>`
          : html`<div class="empty"><div class="empty-title">这个分类下还没有操作日志</div><div class="empty-sub">派单或合并后会实时出现在这里</div></div>`}
      </section>`
  }
}

/* ---------------- 根组件：取数、主题、轮询 ---------------- */
class FmConsole extends LitElement {
  static properties = {
    data: { attribute: false },
    mode: { type: String },
    day: { type: String },
    view: { type: String },
    sidebarCollapsed: { type: Boolean },
    schedules: { attribute: false },
    workHours: { attribute: false },
    operations: { attribute: false },
    inboxData: { attribute: false },
    outboxData: { attribute: false },
    inboxFilter: { type: String },
    outboxFilter: { type: String },
    inboxPage: { type: Number },
    outboxPage: { type: Number },
    inboxBusy: { type: String },
    outboxBusy: { type: String },
    inboxError: { type: String },
    outboxError: { type: String },
    workflow: { attribute: false },
    nodeBusy: { type: String },
    taskTab: { type: String },
    taskPage: { type: Number },
    candidatePage: { type: Number },
    candidates: { attribute: false },
    candInfo: { attribute: false },
    candBusy: { type: String },
    candError: { type: String },
    candNote: { type: String },
    completeBusy: { type: String },
    completeNote: { type: String },
    completeError: { type: String },
    opFilter: { type: String },
    schedBusy: { type: String },
    schedError: { type: String },
    schedNote: { type: String },
    error: { type: String },
  }

  constructor() {
    super()
    this.data = null
    this.mode = "system"
    // Chat 是默认工作台；原有 Inbox / Outbox / Tasks 保留为运维视图。
    this.view = "chat"
    try {
      this.sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === "1"
    } catch {
      this.sidebarCollapsed = false
    }
    this.schedules = []
    this.workHours = { days: [1, 2, 3, 4, 5], start: "08:30", end: "18:30" }
    this.operations = []
    this.inboxData = { events: [], counts: {} }
    this.outboxData = { messages: [], counts: {} }
    this.inboxFilter = "all"
    this.outboxFilter = "all"
    this.inboxPage = 1
    this.outboxPage = 1
    this.inboxBusy = ""
    this.outboxBusy = ""
    this.inboxError = ""
    this.outboxError = ""
    this.workflow = null
    this.nodeBusy = ""
    // 分配任务卡片的两页：today（已分配）/ pending（待分配，可点接单）
    this.taskTab = "today"
    this.taskPage = 1
    this.candidatePage = 1
    this.candidates = []
    this.candInfo = null
    this.candBusy = ""
    this.candError = ""
    this.candNote = ""
    this.completeBusy = ""
    this.completeNote = ""
    this.completeError = ""
    this.opFilter = "all"
    this.schedBusy = ""
    this.schedError = ""
    this.schedNote = ""
    // day 为空 = 看今天；选了某天就回看那天的任务/PR。URL 上带 ?day= 也能直接打开那天。
    this.day = ""
    try {
      const q = new URLSearchParams(location.search).get("day") || ""
      if (/^\d{4}-\d{2}-\d{2}$/.test(q)) this.day = q
    } catch {}
    this.error = ""
  }

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    try {
      this.mode = localStorage.getItem(THEME_KEY) || "system"
    } catch {}
    this.applyTheme()

    this._mq = window.matchMedia("(prefers-color-scheme: dark)")
    this._onSystemTheme = () => {
      if (this.mode === "system") this.applyTheme()
    }
    this._mq.addEventListener?.("change", this._onSystemTheme)

    this._onTheme = (e) => this.setTheme(e.detail.mode)
    this._onDay = (e) => {
      this.day = e.detail.day || ""
      this.taskPage = 1
      this.applyDayToUrl()
      this.load()
    }
    this._onView = (e) => {
      this.view = e.detail.view
      if (this.view === "inbox" || this.view === "outbox") this.loadQueue(this.view)
      if (this.view === "schedules") this.loadSchedules()
      if (this.view === "operations") this.loadOperations()
    }
    this._onSidebarToggle = () => {
      this.sidebarCollapsed = !this.sidebarCollapsed
      try {
        localStorage.setItem(SIDEBAR_KEY, this.sidebarCollapsed ? "1" : "0")
      } catch {}
    }
    this._onSchedSave = (e) => this.saveSchedule(e.detail.id, e.detail.patch)
    this._onScheduleRun = (e) => this.runScheduleNow(e.detail.id)
    this._onOpFilter = (e) => {
      this.opFilter = e.detail.filter
    }
    this._onQueueFilter = (e) => {
      const kind = e.detail.queue === "outbox" ? "outbox" : "inbox"
      this[`${kind}Filter`] = e.detail.status || "all"
      this[`${kind}Page`] = 1
      this.loadQueue(kind)
    }
    this._onQueueRefresh = (e) => this.loadQueue(e.detail.queue)
    this._onPage = (e) => {
      const { scope, page } = e.detail
      if (scope === "inbox" || scope === "outbox") {
        this[`${scope}Page`] = Math.max(1, Number(page) || 1)
        this.loadQueue(scope)
      } else if (scope === "tasks") {
        this.taskPage = Math.max(1, Number(page) || 1)
      } else if (scope === "candidates") {
        this.candidatePage = Math.max(1, Number(page) || 1)
      }
    }
    this.addEventListener("theme-set", this._onTheme)
    this.addEventListener("day-set", this._onDay)
    this.addEventListener("view-set", this._onView)
    this.addEventListener("sidebar-toggle", this._onSidebarToggle)
    this.addEventListener("schedule-save", this._onSchedSave)
    this.addEventListener("schedule-run", this._onScheduleRun)
    this._onNodeToggle = (e) => this.toggleNode(e.detail)
    this.addEventListener("node-toggle", this._onNodeToggle)
    this.addEventListener("operation-filter", this._onOpFilter)
    this.addEventListener("queue-filter", this._onQueueFilter)
    this.addEventListener("queue-refresh", this._onQueueRefresh)
    this.addEventListener("page-set", this._onPage)
    this._onTaskTab = (e) => {
      const tab = e.detail.tab === "pending" ? "pending" : "today"
      if (this.taskTab === tab) return
      this.taskTab = tab
      this.taskPage = 1
      this.candidatePage = 1
      if (tab === "pending") this.loadCandidates()
    }
    this._onCandRefresh = () => this.loadCandidates({ refresh: true })
    this._onCandidatePick = (e) => this.pickCandidate(e.detail)
    this._onTaskComplete = (e) => this.completeTask(e.detail)
    this.addEventListener("task-tab", this._onTaskTab)
    this.addEventListener("candidates-refresh", this._onCandRefresh)
    this.addEventListener("candidate-pick", this._onCandidatePick)
    this.addEventListener("task-complete", this._onTaskComplete)

    this._onFocus = () => {
      this.load()
      this.loadWorkflow()
      if (this.taskTab === "pending") this.loadCandidates()
      if (this.view === "inbox" || this.view === "outbox") this.loadQueue(this.view)
      if (this.view === "schedules") this.loadSchedules()
      if (this.view === "operations") this.loadOperations()
    }
    window.addEventListener("focus", this._onFocus)

    this.load()
    this.loadWorkflow()
    this.loadSchedules()
    this.loadOperations()
    this.loadQueue("inbox")
    this.loadQueue("outbox")
    this._loadTimer = setInterval(() => {
      this.load()
      this.loadWorkflow()
      if (this.view === "inbox" || this.view === "outbox") this.loadQueue(this.view)
      if (this.view === "schedules") this.loadSchedules()
      if (this.view === "operations") this.loadOperations()
    }, 15000)
  }

  disconnectedCallback() {
    clearInterval(this._loadTimer)
    window.removeEventListener("focus", this._onFocus)
    this._mq?.removeEventListener?.("change", this._onSystemTheme)
    this.removeEventListener("theme-set", this._onTheme)
    this.removeEventListener("day-set", this._onDay)
    this.removeEventListener("view-set", this._onView)
    this.removeEventListener("sidebar-toggle", this._onSidebarToggle)
    this.removeEventListener("schedule-save", this._onSchedSave)
    this.removeEventListener("schedule-run", this._onScheduleRun)
    this.removeEventListener("node-toggle", this._onNodeToggle)
    this.removeEventListener("operation-filter", this._onOpFilter)
    this.removeEventListener("queue-filter", this._onQueueFilter)
    this.removeEventListener("queue-refresh", this._onQueueRefresh)
    this.removeEventListener("page-set", this._onPage)
    this.removeEventListener("task-tab", this._onTaskTab)
    this.removeEventListener("candidates-refresh", this._onCandRefresh)
    this.removeEventListener("candidate-pick", this._onCandidatePick)
    this.removeEventListener("task-complete", this._onTaskComplete)
    super.disconnectedCallback()
  }

  applyDayToUrl() {
    try {
      const url = new URL(location.href)
      if (this.day) url.searchParams.set("day", this.day)
      else url.searchParams.delete("day")
      history.replaceState(null, "", url)
    } catch {}
  }

  applyTheme() {
    const resolved = this.mode === "system" ? (this._mq?.matches ? "dark" : "light") : this.mode
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.themeMode = this.mode
  }

  setTheme(mode) {
    try {
      localStorage.setItem(THEME_KEY, mode)
    } catch {}
    this.mode = mode
    this.applyTheme()
  }

  async load() {
    try {
      const q = this.day ? `?day=${encodeURIComponent(this.day)}` : ""
      const res = await fetch(`/api/snapshot${q}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.data = await res.json()
      this.error = ""
    } catch (e) {
      this.error = `服务 · 拿不到数据（${e.message}）`
    }
  }

  // 待分配队列：只读接口，服务端带 45s 缓存，点「刷新」才强拉。
  async loadCandidates({ refresh = false } = {}) {
    if (this.candBusy === "loading") return
    this.candBusy = "loading"
    try {
      const res = await fetch(`/api/candidates${refresh ? "?refresh=1" : ""}`, { cache: "no-store" })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.candidates = body.items || []
      this.candInfo = body
      this.candError = (body.errors || []).length
        ? `有仓库拉不到工单：${body.errors.map((e) => `${e.repo}（${e.message}）`).join("；")}`
        : ""
    } catch (e) {
      this.candError = `拿不到待分配队列：${e.message}`
    } finally {
      this.candBusy = ""
    }
  }

  // 手动接单：只派这一条。派完立刻刷新今日任务与队列，让结果当场可见。
  async pickCandidate({ repo, number } = {}) {
    const key = `${repo}#${number}`
    if (!repo || !number || this.candBusy) return
    this.candBusy = key
    this.candError = ""
    this.candNote = ""
    try {
      const res = await fetch("/api/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, number }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.candError = ""
      this.candNote = body.decision
        ? `已接下 ${key}（决策单）：换了一套提示词让 agent 自己判断要不要做，不登记监听`
        : `已接下 ${key}，工作会话已开`
      await Promise.all([this.load(), this.loadCandidates({ refresh: true }), this.loadWorkflow()])
    } catch (e) {
      this.candError = `接单失败（${key}）：${e.message}`
    } finally {
      this.candBusy = ""
    }
  }

  // 手动完成：服务核对 PR 已 merged 后走原有关单、工作区清理和监听清理。
  async completeTask({ repo, number } = {}) {
    const key = `${repo}#${number}`
    if (!repo || !number || this.completeBusy) return
    this.completeBusy = key
    this.completeNote = ""
    this.completeError = ""
    try {
      const res = await fetch("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, number }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.completeNote = body.skipped === "already-done" ? `${key} 已经是已完成状态` : `${key} 已按远端合并结果完成收尾`
      await Promise.all([this.load(), this.loadWorkflow(), this.loadOperations()])
    } catch (e) {
      this.completeError = `手动完成失败（${key}）：${e.message}`
    } finally {
      this.completeBusy = ""
    }
  }

  async loadWorkflow() {    try {
      const res = await fetch("/api/workflow", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      this.workflow = body.ok === false ? null : body
    } catch (e) {
      this.error = `服务 · 拿不到 workflow（${e.message}）`
    }
  }

  // 暂停/继续一个节点：只动这个节点自己的自动动作，整条 workflow 照走。
  async toggleNode({ stage, paused } = {}) {
    if (!stage || this.nodeBusy) return
    this.nodeBusy = stage
    try {
      const res = await fetch("/api/workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: paused ? "pause" : "resume", stage }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.workflow = { ...(this.workflow || {}), nodes: body.nodes || [] }
      await this.loadWorkflow()
    } catch (e) {
      this.error = `节点开关失败：${e.message}`
    } finally {
      this.nodeBusy = ""
    }
  }

  async loadQueue(kind) {
    const queue = kind === "outbox" ? "outbox" : "inbox"
    if (this[`${queue}Busy`] === "loading") return
    this[`${queue}Busy`] = "loading"
    try {
      const params = new URLSearchParams({
        page: String(this[`${queue}Page`] || 1),
        pageSize: String(PAGE_SIZE),
      })
      const status = this[`${queue}Filter`] || "all"
      if (status !== "all") params.set("status", status)
      const res = await fetch(`/api/${queue}?${params}`, { cache: "no-store" })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || body.error || `HTTP ${res.status}`)
      this[`${queue}Data`] = body
      this[`${queue}Error`] = ""
    } catch (e) {
      this[`${queue}Error`] = `拿不到 ${queue === "outbox" ? "Outbox" : "Inbox"}：${e.message}`
    } finally {
      this[`${queue}Busy`] = ""
    }
  }

  async loadSchedules() {
    try {
      const res = await fetch("/api/schedules", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      this.schedules = body.schedules || []
      if (body.workHours) this.workHours = body.workHours
    } catch (e) {
      this.error = `服务 · 拿不到定时任务（${e.message}）`
    }
  }

  async loadOperations() {
    try {
      const res = await fetch("/api/operations?limit=100", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      this.operations = body.operations || []
    } catch (e) {
      this.error = `服务 · 拿不到操作日志（${e.message}）`
    }
  }

  async saveSchedule(id, patch) {
    if (this.schedBusy || !patch) return
    this.schedError = ""
    this.schedNote = ""
    if (id === "workHours") {
      const hours = patch.workHours || {}
      if (!Array.isArray(hours.days) || hours.days.length === 0) {
        this.schedError = "请至少选择一个工作日"
        return
      }
      if (!hours.start || !hours.end) {
        this.schedError = "请选择开始时间和结束时间"
        return
      }
      if (hours.start >= hours.end) {
        this.schedError = "开始时间必须早于结束时间"
        return
      }
    }
    this.schedBusy = id
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.schedules = body.schedules || []
      if (body.workHours) this.workHours = body.workHours
      this.schedNote = `${this.schedules.find((item) => item.id === id)?.label || id}已保存并立即生效`
      await this.load()
    } catch (e) {
      this.schedError = `保存失败：${e.message}`
    } finally {
      this.schedBusy = ""
    }
  }

  async runScheduleNow(id) {
    if (this.schedBusy) return
    this.schedBusy = `run-${id}`
    this.schedError = ""
    try {
      const res = await fetch("/api/schedules/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      await this.loadSchedules()
      await this.load()
    } catch (e) {
      this.schedError = `立即执行失败：${e.message}`
    } finally {
      this.schedBusy = ""
    }
  }

  render() {
    return html`
      <fm-head .data=${this.data} .mode=${this.mode} .error=${this.error} .day=${this.day} .today=${this.data?.today || ""} .view=${this.view}></fm-head>
      <div class="app-shell">
        <fm-sidebar .view=${this.view} .collapsed=${this.sidebarCollapsed}></fm-sidebar>
        <main>
        ${this.view === "chat"
          ? html`<fm-chat></fm-chat>`
          : this.view === "schedules"
          ? html`<fm-schedules .schedules=${this.schedules} .workHours=${this.workHours} .busy=${this.schedBusy} .error=${this.schedError} .note=${this.schedNote}></fm-schedules>`
          : this.view === "operations"
          ? html`<fm-operations .operations=${this.operations} .filter=${this.opFilter}></fm-operations>`
          : this.view === "inbox"
          ? html`<fm-queue
              kind="inbox"
              .rows=${this.inboxData.events || []}
              .counts=${this.inboxData.counts || {}}
              .filter=${this.inboxFilter}
              .page=${this.inboxData.page || this.inboxPage}
              .pageSize=${this.inboxData.pageSize || PAGE_SIZE}
              .total=${this.inboxData.total || 0}
              .busy=${this.inboxBusy}
              .error=${this.inboxError}
            ></fm-queue>`
          : this.view === "outbox"
          ? html`<fm-queue
              kind="outbox"
              .rows=${this.outboxData.messages || []}
              .counts=${this.outboxData.counts || {}}
              .filter=${this.outboxFilter}
              .page=${this.outboxData.page || this.outboxPage}
              .pageSize=${this.outboxData.pageSize || PAGE_SIZE}
              .total=${this.outboxData.total || 0}
              .busy=${this.outboxBusy}
              .error=${this.outboxError}
            ></fm-queue>`
          : this.data
          ? html`
              <fm-stats .stats=${this.data.stats} .scope=${this.data.isToday === false ? this.data.day : "今日"}></fm-stats>
              <fm-tasks
                .tasks=${this.data.tasks}
                .sessions=${this.data.sessions}
                .summary=${this.data.summary}
                .isToday=${this.data.isToday !== false}
                .nodes=${this.workflow?.nodes || []}
                .runs=${this.workflow?.runs || []}
                .workflows=${this.workflow?.workflows || []}
                .scope=${this.data.isToday === false ? this.data.day : "今日"}
                .tab=${this.taskTab}
                .page=${this.taskPage}
                .candidatePage=${this.candidatePage}
                .candidates=${this.candidates}
                .candInfo=${this.candInfo}
                .candBusy=${this.candBusy}
                .candError=${this.candError}
                .candNote=${this.candNote}
                .completeBusy=${this.completeBusy}
                .completeNote=${this.completeNote}
                .completeError=${this.completeError}
              ></fm-tasks>`
          : html`
              <section class="panel">
                <div class="empty">
                  <div class="empty-title">正在连接 foreman 服务…</div>
                  <div class="empty-sub">${this.error || "首次加载需要几秒"}</div>
                </div>
              </section>`}
        </main>
      </div>`
  }
}

customElements.define("fm-theme-switch", FmThemeSwitch)
customElements.define("fm-sidebar", FmSidebar)
customElements.define("fm-head", FmHead)
customElements.define("fm-stats", FmStats)
customElements.define("fm-pagination", FmPagination)
customElements.define("fm-tasks", FmTasks)
customElements.define("fm-queue", FmQueue)
customElements.define("fm-schedules", FmSchedules)
customElements.define("fm-operations", FmOperations)
customElements.define("fm-console", FmConsole)
