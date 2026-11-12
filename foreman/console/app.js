/*
 * foreman 控制台：Lit 3 组件化前端。
 * 源码用裸 `lit` 导入，由 Vite 打包成 console/dist（`npm run build:console`），
 * 常驻服务直接下发 dist，不依赖 CDN，也不需要运行时 vendor 文件。
 * 组件都用 light DOM（createRenderRoot 返回 this），样式继续吃 style.css 的全局类。
 */
import { LitElement, html } from "lit"

const STATE_LABEL = {
  planned: "已计划",
  working: "进行中",
  done: "已完成",
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
  if (id === "overview") {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v5h4M10 12h6M10 16h6M10 8h2"/></svg>`
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
      { id: "overview", label: "工单" },
      { id: "schedules", label: "定时任务" },
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
    return html`
      <header class="topbar">
        <div class="brand">
          <span class=${"pulse" + (d && !svc.alive ? " is-off" : "")}></span>
          <span class="brand-text">FOREMAN<span class="thin">/CONSOLE</span></span>
        </div>
        <div class="meta">
          <span class="meta-item day-wrap">
            <span class="day-label">看哪天</span>
            <input
              class="date-pick"
              type="date"
              max=${this.today || ""}
              .value=${this.day || this.today || ""}
              @change=${(e) => emit(this, "day-set", { day: e.target.value })}
            />
            ${this.day && this.day !== this.today
              ? html`<button class="ghost day-today" @click=${() => emit(this, "day-set", { day: "" })}>回到今天</button>`
              : ""}
          </span>
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
      { label: `${scope} 分配任务`, value: s.tasks, sub: `历史累计 ${s.historyTasks ?? 0} 单`, accent: "accent-cyan" },
      { label: "进行中", value: s.working, sub: `已出 PR ${s.prOpen ?? 0}`, accent: "accent-green" },
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

/* ---------------- 今日任务（可展开看每个节点的详情） ---------------- */
class FmTasks extends LitElement {
  static properties = {
    tasks: { attribute: false },
    nodes: { attribute: false },
    runs: { attribute: false },
    workflows: { attribute: false },
    scope: { type: String },
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
  render() {
    const rows = this.tasks || []
    const scope = this.scope || "今日"
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>${scope} 分配任务</h2>
          <div class="panel-side">
            <span class="hint">${rows.length ? `${rows.length} 条 · 点「详情」看每个节点` : "暂无"}</span>
          </div>
        </div>
        ${rows.length
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
                    ${rows.map((t) => {
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
                          </td>
                        </tr>
                        ${this.openKey === key ? this.detail(t) : ""}`
                    })}
                  </tbody>
                </table>
              </div>`
          : html`
              <div class="empty">
                <div class="empty-title">今天还没有分配到任务</div>
                <div class="empty-sub">foreman run 派活后会出现在这里</div>
              </div>`}
      </section>`
  }
}

/* ---------------- 定时任务 ---------------- */
class FmSchedules extends LitElement {
  static properties = { schedules: { attribute: false }, busy: { type: String }, error: { type: String } }
  createRenderRoot() {
    return this
  }
  saveCron(id) {
    const input = this.querySelector(`input[data-cron="${id}"]`)
    if (input) emit(this, "schedule-save", { id, cron: input.value.trim() })
  }
  render() {
    const rows = this.schedules || []
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>定时任务</h2>
          <div class="panel-side">
            <span class="hint">cron 格式：分 时 日 月 周；也支持第 6 段秒</span>
            <button class="ghost" ?disabled=${this.busy === "pickup-run"} @click=${() => emit(this, "pickup-now")}>
              ${this.busy === "pickup-run" ? "巡检中…" : "立即巡检"}
            </button>
          </div>
        </div>
        ${this.error ? html`<div class="sched-error">${this.error}</div>` : ""}
        <ul class="sched-list">
          ${rows.map((s) => html`
            <li class="sched">
              <div class="sched-main">
                <span class=${"dot " + (s.enabled ? "on" : "off")}></span>
                <span class="sched-name">${s.label}</span>
                <span class=${"badge " + (s.enabled ? "notified" : "self")}>${s.enabled ? "运行中" : "已停止"}</span>
                <span class="sched-detail">${s.detail || ""}</span>
              </div>
              <div class="sched-meta">
                ${s.lastAt ? html`<span class="pr-note">上次 ${s.lastAt}</span>` : ""}
                ${s.count ? html`<span class="pr-note">已跑 ${s.count} 轮</span>` : ""}
                ${s.lastResult ? html`<span class="pr-note">${s.lastResult}</span>` : ""}
              </div>
              <div class="sched-acts">
                <button
                  class=${s.enabled ? "ghost danger" : "ghost"}
                  ?disabled=${this.busy === s.id}
                  @click=${() => emit(this, "schedule-toggle", { id: s.id, enabled: !s.enabled })}
                >${this.busy === s.id ? "…" : s.enabled ? "停止" : "开启"}</button>
              </div>
              ${s.cron !== undefined
                ? html`<div class="sched-cron">
                    <span class="cron-label">cron</span>
                    <input
                      class="cron-input"
                      data-cron=${s.id}
                      value=${s.cron || ""}
                      spellcheck="false"
                      placeholder="*/30 * * * *"
                      @keydown=${(e) => { if (e.key === "Enter") this.saveCron(s.id) }}
                    />
                    <button class="ghost" ?disabled=${this.busy === `cron-${s.id}`} @click=${() => this.saveCron(s.id)}>
                      ${this.busy === `cron-${s.id}` ? "保存中…" : "保存时间"}
                    </button>
                    <span class="pr-note">${s.nextAt ? `下次 ${s.nextAt}` : s.enabled ? "等待排期" : "开启后生效"}</span>
                  </div>`
                : ""}
            </li>`)}
          ${rows.length ? "" : html`<li class="empty"><div class="empty-title">暂时取不到开关状态</div></li>`}
        </ul>
      </section>`
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

/* ---------------- 页脚 ---------------- */
class FmFoot extends LitElement {
  static properties = {
    data: { attribute: false },
    busy: { type: String },
  }
  createRenderRoot() {
    return this
  }
  render() {
    const d = this.data
    const st = d?.storage
    const btnText = this.busy === "busy" ? "扫描中…" : this.busy === "ok" ? "已同步" : this.busy === "fail" ? "同步失败" : "立即扫描"
    return html`
      <footer>
        <span>数据源 · ${st ? `${st.driver} · ${st.file.split("/").pop()}` : "—"}</span>
        <span class="dot-sep">·</span>
        <span>账本更新 · ${d?.generatedAtClock || "—"}</span>
        <span class="dot-sep">·</span>
        <span>快照生成 · ${d?.generatedAtClock || "—"}</span>
        <span class="dot-sep">·</span>
        <span>
          ${st ? `SQLite · 去重键 ${st.uniqueKey} · 快照 ${st.rows.polls} 次` : "SQLite · —"}
        </span>
        <span class="dot-sep">·</span>
        <span>
          ${`API · /api/snapshot · ${d?.isToday === false ? `${d.day} · ` : ""}${d?.tasks?.length ?? 0} 单 / ${d?.prs?.length ?? 0} PR`}
        </span>
        <button class="ghost" ?disabled=${this.busy === "busy"} @click=${() => emit(this, "refresh")}>
          ${btnText}
        </button>
      </footer>`
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
    operations: { attribute: false },
    workflow: { attribute: false },
    nodeBusy: { type: String },
    opFilter: { type: String },
    schedBusy: { type: String },
    schedError: { type: String },
    busy: { type: String },
    error: { type: String },
  }

  constructor() {
    super()
    this.data = null
    this.mode = "system"
    // view：overview（工单）/ schedules（定时任务）/ operations（操作日志）
    this.view = "overview"
    try {
      this.sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === "1"
    } catch {
      this.sidebarCollapsed = false
    }
    this.schedules = []
    this.operations = []
    this.workflow = null
    this.nodeBusy = ""
    this.opFilter = "all"
    this.schedBusy = ""
    this.schedError = ""
    // day 为空 = 看今天；选了某天就回看那天的任务/PR。URL 上带 ?day= 也能直接打开那天。
    this.day = ""
    try {
      const q = new URLSearchParams(location.search).get("day") || ""
      if (/^\d{4}-\d{2}-\d{2}$/.test(q)) this.day = q
    } catch {}
    this.busy = ""
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
      this.applyDayToUrl()
      this.load()
    }
    this._onRefresh = () => this.syncNow()
    this._onView = (e) => {
      this.view = e.detail.view
      if (this.view === "schedules") this.loadSchedules()
      if (this.view === "operations") this.loadOperations()
    }
    this._onSchedToggle = (e) => this.toggleSchedule(e.detail.id, e.detail.enabled)
    this._onSidebarToggle = () => {
      this.sidebarCollapsed = !this.sidebarCollapsed
      try {
        localStorage.setItem(SIDEBAR_KEY, this.sidebarCollapsed ? "1" : "0")
      } catch {}
    }
    this._onSchedSave = (e) => this.saveScheduleCron(e.detail.id, e.detail.cron)
    this._onPickupNow = () => this.pickupNow()
    this._onOpFilter = (e) => {
      this.opFilter = e.detail.filter
    }
    this.addEventListener("theme-set", this._onTheme)
    this.addEventListener("day-set", this._onDay)
    this.addEventListener("refresh", this._onRefresh)
    this.addEventListener("view-set", this._onView)
    this.addEventListener("sidebar-toggle", this._onSidebarToggle)
    this.addEventListener("schedule-toggle", this._onSchedToggle)
    this.addEventListener("schedule-save", this._onSchedSave)
    this.addEventListener("pickup-now", this._onPickupNow)
    this._onNodeToggle = (e) => this.toggleNode(e.detail)
    this.addEventListener("node-toggle", this._onNodeToggle)
    this.addEventListener("operation-filter", this._onOpFilter)

    this._onFocus = () => {
      this.load()
      this.loadWorkflow()
      if (this.view === "schedules") this.loadSchedules()
      if (this.view === "operations") this.loadOperations()
    }
    window.addEventListener("focus", this._onFocus)

    this.load()
    this.loadWorkflow()
    this.loadSchedules()
    this.loadOperations()
    this._loadTimer = setInterval(() => {
      this.load()
      this.loadWorkflow()
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
    this.removeEventListener("refresh", this._onRefresh)
    this.removeEventListener("view-set", this._onView)
    this.removeEventListener("sidebar-toggle", this._onSidebarToggle)
    this.removeEventListener("schedule-toggle", this._onSchedToggle)
    this.removeEventListener("schedule-save", this._onSchedSave)
    this.removeEventListener("pickup-now", this._onPickupNow)
    this.removeEventListener("node-toggle", this._onNodeToggle)
    this.removeEventListener("operation-filter", this._onOpFilter)
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

  async syncNow() {
    if (this.busy === "busy") return
    this.busy = "busy"
    try {
      const res = await fetch("/api/sync", { method: "POST" })
      const body = await res.json()
      await this.load()
      this.busy = body.ok ? "ok" : "fail"
    } catch {
      this.busy = "fail"
    } finally {
      setTimeout(() => {
        this.busy = ""
      }, 1600)
    }
  }

  async loadWorkflow() {
    try {
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

  async loadSchedules() {
    try {
      const res = await fetch("/api/schedules", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      this.schedules = body.schedules || []
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

  async toggleSchedule(id, enabled) {
    if (this.schedBusy) return
    this.schedBusy = id
    this.schedError = ""
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { [id]: enabled } }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      await this.loadSchedules()
    } catch (e) {
      this.schedError = `开关失败：${e.message}`
    } finally {
      this.schedBusy = ""
    }
  }

  async saveScheduleCron(id, cron) {
    if (this.schedBusy) return
    this.schedBusy = `cron-${id}`
    this.schedError = ""
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { [id]: { cron } } }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.schedules = body.schedules || []
    } catch (e) {
      this.schedError = `保存失败：${e.message}`
    } finally {
      this.schedBusy = ""
    }
  }

  async pickupNow() {
    if (this.schedBusy) return
    this.schedBusy = "pickup-run"
    try {
      await fetch("/api/pickup", { method: "POST" })
      await this.loadSchedules()
      await this.load()
    } finally {
      this.schedBusy = ""
    }
  }

  render() {
    return html`
      <fm-head .data=${this.data} .mode=${this.mode} .error=${this.error} .day=${this.day} .today=${this.data?.today || ""}></fm-head>
      <div class="app-shell">
        <fm-sidebar .view=${this.view} .collapsed=${this.sidebarCollapsed}></fm-sidebar>
        <main>
        ${this.view === "schedules"
          ? html`<fm-schedules .schedules=${this.schedules} .busy=${this.schedBusy} .error=${this.schedError}></fm-schedules>`
          : this.view === "operations"
          ? html`<fm-operations .operations=${this.operations} .filter=${this.opFilter}></fm-operations>`
          : this.data
          ? html`
              <fm-stats .stats=${this.data.stats} .scope=${this.data.isToday === false ? this.data.day : "今日"}></fm-stats>
              <fm-tasks
                .tasks=${this.data.tasks}
                .nodes=${this.workflow?.nodes || []}
                .runs=${this.workflow?.runs || []}
                .workflows=${this.workflow?.workflows || []}
                .scope=${this.data.isToday === false ? this.data.day : "今日"}
              ></fm-tasks>`
          : html`
              <section class="panel">
                <div class="empty">
                  <div class="empty-title">正在连接 foreman 服务…</div>
                  <div class="empty-sub">${this.error || "首次加载需要几秒"}</div>
                </div>
              </section>`}
        </main>
      </div>
      <fm-foot .data=${this.data} .busy=${this.busy}></fm-foot>`
  }
}

customElements.define("fm-theme-switch", FmThemeSwitch)
customElements.define("fm-sidebar", FmSidebar)
customElements.define("fm-head", FmHead)
customElements.define("fm-stats", FmStats)
customElements.define("fm-tasks", FmTasks)
customElements.define("fm-schedules", FmSchedules)
customElements.define("fm-operations", FmOperations)
customElements.define("fm-foot", FmFoot)
customElements.define("fm-console", FmConsole)
