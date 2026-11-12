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

const HIST_KIND = {
  task_new: { label: "接到", tone: "planned" },
  task_state: { label: "状态", tone: "working" },
  task_attempt: { label: "重试", tone: "needs-human" },
  pr_new: { label: "发现 PR", tone: "planned" },
  pr_state: { label: "PR 状态", tone: "working" },
  pr_open: { label: "建 PR", tone: "pr-open" },
  pr_merge: { label: "合并", tone: "done" },
  issue_comment: { label: "评论", tone: "planned" },
  issue_close: { label: "关单", tone: "done" },
}

const THEME_KEY = "foreman-theme"
const pad2 = (n) => String(n).padStart(2, "0")
const emit = (host, name, detail) =>
  host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
const clockText = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`

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

/* ---------------- 顶栏 ---------------- */
class FmHead extends LitElement {
  static properties = {
    data: { attribute: false },
    mode: { type: String },
    error: { type: String },
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
          <span class="meta-item">${d?.today || "—"}</span>
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
  static properties = { stats: { attribute: false } }
  createRenderRoot() {
    return this
  }
  render() {
    const s = this.stats || {}
    const cards = [
      { label: "今日分配任务", value: s.tasks, sub: `历史累计 ${s.historyTasks ?? 0} 单`, accent: "accent-cyan" },
      { label: "进行中", value: s.working, sub: `已出 PR ${s.prOpen ?? 0}`, accent: "accent-green" },
      { label: "今日 PR", value: s.prs, sub: `历史 ${s.historyPrs ?? 0} 条 · 新增 ${s.newPrs ?? 0}`, accent: "accent-cyan" },
      { label: "待通知", value: s.pending, sub: "非本人作者、未发出", accent: "accent-amber" },
      { label: "已跳过", value: s.skipped, sub: "作者是自己", accent: "accent-red" },
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

/* ---------------- 今日任务 ---------------- */
class FmTasks extends LitElement {
  static properties = { tasks: { attribute: false } }
  createRenderRoot() {
    return this
  }
  render() {
    const rows = this.tasks || []
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>今日分配任务</h2>
          <div class="panel-side">
            <span class="hint">${rows.length ? `${rows.length} 条 · 当天有更新` : "暂无"}</span>
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
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map(
                      (t) => html`
                        <tr>
                          <td class="id-cell">
                            <span class="repo">${t.repo}#</span><span>${t.number}</span>
                          </td>
                          <td class="title-cell" title=${t.title || ""}>${t.title || "（无标题）"}</td>
                          <td><span class="badge ${t.state}">${STATE_LABEL[t.state] || t.state}</span></td>
                          <td class="branch-cell" title=${t.branch || ""}>${t.branch || "—"}</td>
                          <td class="try-cell">${t.attempts ? `#${t.attempts}` : "—"}</td>
                          <td class="time-cell">${t.updatedAtClock || "—"}</td>
                        </tr>`
                    )}
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

/* ---------------- PR 通知 ---------------- */
class FmPrs extends LitElement {
  static properties = { data: { attribute: false }, filter: { type: String } }
  createRenderRoot() {
    return this
  }
  render() {
    const d = this.data || {}
    const all = d.prs || []
    const prw = d.prWatch || {}
    const counts = {
      all: all.length,
      pending: all.filter((p) => p.pending).length,
      notified: all.filter((p) => p.state === "notified").length,
      skipped: all.filter((p) => p.state === "skipped").length,
    }
    const label = { all: "全部", pending: "待通知", notified: "已通知", skipped: "已跳过" }
    const rows =
      this.filter === "pending"
        ? all.filter((p) => p.pending)
        : this.filter === "notified"
        ? all.filter((p) => p.state === "notified")
        : this.filter === "skipped"
        ? all.filter((p) => p.state === "skipped")
        : all
    const polls = (d.recentPolls || []).slice(0, 5)

    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>PR 通知</h2>
          <div class="panel-side">
            <span class="hint">
              ${prw.enabled
                ? `扫 ${(d.repos || []).length} 个仓库 · 每 ${prw.intervalSeconds || "?"}s`
                : "监听未开启"}
            </span>
            <div class="tabs">
              ${["all", "pending", "notified", "skipped"].map(
                (k) => html`
                  <button
                    class=${"tab " + (this.filter === k ? "is-active" : "")}
                    @click=${() => emit(this, "filter-set", { filter: k })}
                  >${label[k]} ${counts[k] ?? 0}</button>`
              )}
            </div>
          </div>
        </div>

        ${polls.length
          ? html`
              <div class="poll-strip">
                <span class="poll-label">最近扫描</span>
                ${polls.map(
                  (p) => html`
                    <span class="p-chip" title=${`第 ${p.id} 次快照`}>
                      <span class="p-time">${p.atClock || "—"}</span>
                      <span class="p-nums">${p.tasks}单/${p.prs}PR +${p.newTasks}/+${p.newPrs}</span>
                      ${p.pending ? html`<span class="p-flag">${p.pending} 待通知</span>` : ""}
                    </span>`
                )}
              </div>`
          : ""}

        ${rows.length
          ? html`
              <ul class="pr-list">
                ${rows.map(
                  (p) => html`
                    <li class="pr">
                      <div class="pr-main">
                        <span class="pr-num">
                          <span class="repo">${p.repo}#</span><span>${p.number}</span>
                        </span>
                        <span class="pr-title">${p.title || "（无标题）"}</span>
                        ${p.url
                          ? html`<a class="pr-link" href=${p.url} target="_blank" rel="noreferrer">打开</a>`
                          : ""}
                      </div>
                      <div class="pr-meta">
                        <span class="chip">作者 <span class="mono">${p.author || "未知"}</span></span>
                        ${p.state === "skipped"
                          ? html`<span class="badge self">跳过 · 自己的</span>`
                          : p.state === "notified"
                          ? html`<span class="badge notified">已通知 ${p.notifiedAtClock || ""}</span>`
                          : html`<span class="badge pending">待通知</span>`}
                        <span class="pr-note">发现 ${p.seenAtClock || "—"}</span>
                        ${p.notifiedTo ? html`<span class="pr-note">→ ${p.notifiedTo}</span>` : ""}
                      </div>
                    </li>`
                )}
              </ul>`
          : html`
              <div class="empty">
                <div class="empty-title">
                  ${this.filter === "all" ? "今天还没有扫到 PR" : "这个分类下暂时没有 PR"}
                </div>
                <div class="empty-sub">服务每 5 分钟扫一遍配置里的仓库</div>
              </div>`}
      </section>`
  }
}

/* ---------------- 历史 ---------------- */
class FmHistory extends LitElement {
  static properties = { hist: { attribute: false }, days: { type: Number }, day: { type: String } }
  createRenderRoot() {
    return this
  }
  render() {
    const h = this.hist
    const groups = h?.groups || []
    const picked = this.day || ""
    const span = picked || (this.days > 0 ? `近 ${this.days} 天` : "全部")
    const tabs = [
      [1, "今天"],
      [7, "近 7 天"],
      [30, "近 30 天"],
      [0, "全部"],
    ]
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`
    return html`
      <section class="panel">
        <div class="panel-head">
          <h2>历史</h2>
          <div class="panel-side">
            <span class="hint">${h ? `${span} · ${h.total} 条事件` : "加载中…"}</span>
            <div class="tabs">
              ${tabs.map(
                ([v, t]) => html`
                  <button
                    class=${"tab " + (!picked && v === this.days ? "is-active" : "")}
                    @click=${() => emit(this, "days-set", { days: v })}
                  >${t}</button>`
              )}
            </div>
            <input
              class="hist-date"
              type="date"
              aria-label="按日期查看历史"
              max=${todayStr}
              .value=${picked}
              @change=${(e) => emit(this, "day-set", { day: e.target.value })}
            />
          </div>
        </div>

        ${groups.length
          ? html`
              <ul class="pr-list">
                ${groups.map(
                  (g) => html`
                    <li class="hist-day">
                      <span class="hist-day-date mono">${g.day}</span>
                      <span class="hist-day-sum">
                        ${g.count} 条 · 工单 ${g.tasks.length} · PR ${g.prs.length}
                      </span>
                    </li>
                    ${(g.items || []).map((it) => {
                      const kind = HIST_KIND[it.kind] || { label: it.kind, tone: "" }
                      return html`
                        <li class="pr hist-item">
                          <div class="pr-main">
                            <span class="hist-time mono">${it.atClock || "—"}</span>
                            <span class=${"badge " + kind.tone}>${kind.label}</span>
                            <span class="pr-num">
                              <span class="repo">${it.repo}#</span><span>${it.number}</span>
                            </span>
                            <span class="pr-title">${it.title || "（无标题）"}</span>
                          </div>
                          ${it.from || it.to || it.detail || it.agent
                            ? html`
                                <div class="pr-meta">
                                  ${it.from || it.to
                                    ? html`<span class="hist-change mono">${it.from || "—"} → ${it.to || "—"}</span>`
                                    : ""}
                                  ${it.detail ? html`<span class="pr-note">${it.detail}</span>` : ""}
                                  ${it.agent ? html`<span class="chip">${it.agent}</span>` : ""}
                                </div>`
                            : ""}
                        </li>`
                    })}
                  </li>`
                )}
              </ul>`
          : html`
              <div class="empty">
                <div class="empty-title">这段时间没有历史记录</div>
                <div class="empty-sub">接到、状态变更、重试、建 PR、合并、评论、关单都会留痕</div>
              </div>`}
      </section>`
  }
}

/* ---------------- 页脚 ---------------- */
class FmFoot extends LitElement {
  static properties = {
    data: { attribute: false },
    hist: { attribute: false },
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
          ${`API · /api/snapshot · ${d?.tasks?.length ?? 0} 单 / ${d?.prs?.length ?? 0} PR${this.hist ? ` · 历史 ${this.hist.total ?? 0} 条` : ""}`}
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
    hist: { attribute: false },
    mode: { type: String },
    filter: { type: String },
    histDays: { type: Number },
    histDay: { type: String },
    busy: { type: String },
    error: { type: String },
  }

  constructor() {
    super()
    this.data = null
    this.hist = null
    this.mode = "system"
    this.filter = "all"
    this.histDays = 7
    this.histDay = ""
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
    this._onFilter = (e) => {
      this.filter = e.detail.filter
    }
    this._onDays = (e) => {
      this.histDays = e.detail.days
      this.histDay = ""
      this.loadHistory()
    }
    this._onDay = (e) => {
      this.histDay = e.detail.day || ""
      this.loadHistory()
    }
    this._onRefresh = () => this.syncNow()
    this.addEventListener("theme-set", this._onTheme)
    this.addEventListener("filter-set", this._onFilter)
    this.addEventListener("days-set", this._onDays)
    this.addEventListener("day-set", this._onDay)
    this.addEventListener("refresh", this._onRefresh)

    this._onFocus = () => this.load()
    window.addEventListener("focus", this._onFocus)

    this.load()
    this._loadTimer = setInterval(() => this.load(), 15000)
  }

  disconnectedCallback() {
    clearInterval(this._loadTimer)
    window.removeEventListener("focus", this._onFocus)
    this._mq?.removeEventListener?.("change", this._onSystemTheme)
    this.removeEventListener("theme-set", this._onTheme)
    this.removeEventListener("filter-set", this._onFilter)
    this.removeEventListener("days-set", this._onDays)
    this.removeEventListener("day-set", this._onDay)
    this.removeEventListener("refresh", this._onRefresh)
    super.disconnectedCallback()
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
      const res = await fetch("/api/snapshot", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.data = await res.json()
      this.error = ""
      await this.loadHistory()
    } catch (e) {
      this.error = `服务 · 拿不到数据（${e.message}）`
    }
  }

  async loadHistory() {
    try {
      const q = this.histDay
        ? `day=${encodeURIComponent(this.histDay)}`
        : `days=${this.histDays}`
      const res = await fetch(`/api/history?${q}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.hist = await res.json()
    } catch (e) {
      this.hist = { groups: [], total: 0, eventsInDb: 0, availableDays: [], error: e.message }
    }
  }

  async syncNow() {
    if (this.busy === "busy") return
    this.busy = "busy"
    try {
      const res = await fetch("/api/sync", { method: "POST" })
      const body = await res.json()
      if (body.snapshot) {
        this.data = body.snapshot
      } else {
        await this.load()
      }
      await this.loadHistory()
      this.busy = body.ok ? "ok" : "fail"
    } catch {
      this.busy = "fail"
    } finally {
      setTimeout(() => {
        this.busy = ""
      }, 1600)
    }
  }

  render() {
    return html`
      <fm-head .data=${this.data} .mode=${this.mode} .error=${this.error}></fm-head>
      <main>
        ${this.data
          ? html`
              <fm-stats .stats=${this.data.stats}></fm-stats>
              <fm-tasks .tasks=${this.data.tasks}></fm-tasks>
              <fm-prs .data=${this.data} .filter=${this.filter}></fm-prs>
              <fm-history .hist=${this.hist} .days=${this.histDays} .day=${this.histDay}></fm-history>`
          : html`
              <section class="panel">
                <div class="empty">
                  <div class="empty-title">正在连接 foreman 服务…</div>
                  <div class="empty-sub">${this.error || "首次加载需要几秒"}</div>
                </div>
              </section>`}
      </main>
      <fm-foot .data=${this.data} .hist=${this.hist} .busy=${this.busy}></fm-foot>`
  }
}

customElements.define("fm-theme-switch", FmThemeSwitch)
customElements.define("fm-head", FmHead)
customElements.define("fm-stats", FmStats)
customElements.define("fm-tasks", FmTasks)
customElements.define("fm-prs", FmPrs)
customElements.define("fm-history", FmHistory)
customElements.define("fm-foot", FmFoot)
customElements.define("fm-console", FmConsole)
