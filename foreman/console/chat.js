import { LitElement, html } from "lit"

const emit = (host, name, detail) =>
  host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))

const CHAT_UI_MARKER = "【Chat UI 用户消息】"
const TOOL_STATUS = { pending: "待执行", running: "执行中", completed: "完成", error: "出错" }
// 斜杠命令：目前只有 /clear（新建 Router 会话）。加新命令在这里追加即可。
const SLASH_COMMANDS = [{ cmd: "clear", desc: "新建 Router 会话（旧会话进历史，可在列表归档）" }]

class FmChat extends LitElement {
  static properties = {
    draft: { type: String },
    busy: { type: Boolean },
    loading: { type: Boolean },
    error: { type: String },
    notice: { type: String },
    // 要看的会话目标（来自侧边栏点选）；空 = router 当前会话。
    conv: { type: String },
    // 执行载体：zcode = 实时流模式（SSE 步进转录），其余 = 老账本轮询模式。
    carrier: { type: String },
    // 内部响应式状态：滚动到底部按钮显隐、斜杠命令草稿。
    showJump: { state: true },
    slash: { state: true },
  }

  constructor() {
    super()
    this.draft = ""
    this.busy = false
    this.loading = false
    this.error = ""
    this.notice = ""
    this.conv = ""
    this.carrier = ""
    this._es = null
    this._esFails = 0
    this._pollTimer = null
    this._pendingTimer = null
    this._cursor = 0
    this._running = false
    this._title = ""
    this._readOnly = false
    this._transport = "" // sse | poll | legacy
    this._msgById = new Map()
    this._partById = new Map()
    this._pendingMessages = []
    this._sending = false
    this.conversationOld = null
    this._legacyTimer = null
    this.showJump = false
    this.slash = ""
  }

  createRenderRoot() {
    return this
  }

  get streamMode() {
    return this.carrier === "zcode"
  }

  connectedCallback() {
    super.connectedCallback()
    if (this.streamMode) this._connectStream()
    else {
      this.load()
      // 老模式自适应轮询：只在有活动（running / 有待投递）时跟 5 秒，空转不追。
      this._legacyTimer = setInterval(() => {
        if (document.hidden) return
        const c = this.conversationOld
        if (c?.running || (c?.pending ?? 0) > 0) this.load()
      }, 5000)
    }
    // pending 队列只有 router 会话有：轻轮询老接口拿 Inbox 队列（流里只有投递后的消息）。
    this._pendingTimer = setInterval(() => {
      if (!document.hidden && !this.conv && this.streamMode) this._loadPending()
    }, 12000)
    if (this.streamMode && !this.conv) this._loadPending()
  }

  disconnectedCallback() {
    this._closeStream()
    clearInterval(this._pollTimer)
    clearInterval(this._pendingTimer)
    clearInterval(this._legacyTimer)
    this._pollTimer = null
    this._pendingTimer = null
    this._legacyTimer = null
    super.disconnectedCallback()
  }

  willUpdate(changed) {
    if (changed.has("conv") && changed.get("conv") !== undefined) {
      // 侧栏点选切换：清空现场重连（草稿保留）。
      this._reset()
      if (this.streamMode) {
        this._connectStream()
        if (!this.conv) this._loadPending()
      } else {
        this.load()
      }
    }
    if (changed.has("carrier") && changed.get("carrier") !== undefined && changed.get("carrier") !== this.carrier) {
      this._reset()
      if (this.streamMode) this._connectStream()
      else this.load()
    }
  }

  updated() {
    // 流式期间别抢用户回看：只有贴底时才自动跟随。
    const list = this.querySelector(".chat-messages")
    if (list) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140
      if (nearBottom || this._sending) list.scrollTop = list.scrollHeight
    }
    this._sending = false
    emit(this, "chat-state", {
      running: this.streamMode ? this._running : !!this.conversationOld?.running,
      pending: this._pendingMessages.length > 0,
      loading: !!this.loading,
    })
  }

  _reset() {
    this._msgById = new Map()
    this._partById = new Map()
    this._cursor = 0
    this._running = false
    this._title = ""
    this._readOnly = Boolean(this.conv)
    this._pendingMessages = []
    this._esFails = 0
    this.error = ""
    this.notice = ""
  }

  _closeStream() {
    if (this._es) {
      this._es.close()
      this._es = null
    }
  }

  _stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  }

  // ---- 实时流模式（zcode 载体）：SSE 快照 + 增量，坏了两次降级轮询 ----
  _connectStream() {
    this._closeStream()
    this._stopPoll()
    this._transport = "sse"
    let es
    try {
      es = new EventSource(`/api/chat/stream?conv=${encodeURIComponent(this.conv || "")}`)
    } catch {
      return this._startPoll()
    }
    this._es = es
    es.addEventListener("open", () => {
      this._esFails = 0
      this.error = ""
    })
    es.addEventListener("snapshot", (event) => {
      this._reset()
      this._esFails = 0
      this._applySnapshot(JSON.parse(event.data))
    })
    es.addEventListener("delta", (event) => this._applyDelta(JSON.parse(event.data)))
    es.addEventListener("status", (event) => {
      this._running = Boolean(JSON.parse(event.data).running)
      this.requestUpdate()
    })
    es.addEventListener("stream-error", (event) => {
      this.notice = `实时流异常：${JSON.parse(event.data).message}（持续重试中）`
    })
    es.onerror = () => {
      this._esFails += 1
      if (this._esFails >= 3) this._startPoll()
    }
  }

  _startPoll() {
    this._closeStream()
    if (this._pollTimer) return
    this._transport = "poll"
    this.notice = "实时流不可用，已切换 2 秒轮询"
    this._pollTimer = setInterval(async () => {
      if (document.hidden) return
      try {
        const res = await fetch(`/api/chat/transcript?conv=${encodeURIComponent(this.conv || "")}&since=${this._cursor}`, { cache: "no-store" })
        const body = await res.json()
        if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
        this.error = ""
        this._applySnapshot(body)
      } catch (e) {
        this.error = `拿不到会话转录：${e.message}`
      }
    }, 2000)
  }

  _applySnapshot(body) {
    this._msgById = new Map()
    this._partById = new Map()
    this._title = body.name || this._title
    this._readOnly = Boolean(body.readOnly)
    this._running = Boolean(body.running)
    this._applyRows(body.rows || [])
    this._cursor = Number(body.cursor) || 0
  }

  _applyDelta(body) {
    if (body.name) this._title = body.name
    if (body.readOnly !== undefined) this._readOnly = Boolean(body.readOnly)
    this._applyRows(body.rows || [])
    this._cursor = Math.max(this._cursor, Number(body.cursor) || 0)
  }

  _applyRows(rows) {
    for (const row of rows) {
      if (row.kind === "message") this._msgById.set(row.id, row)
      else if (row.kind === "part") this._partById.set(row.id, row)
    }
    // Maps 是非声明字段，Lit 察觉不到变更——手动请一次重渲染。
    this.requestUpdate()
  }

  async _loadPending() {
    try {
      const res = await fetch("/api/chat", { cache: "no-store" })
      const body = await res.json()
      if (!res.ok || body.ok === false) return
      this._pendingMessages = body.pendingMessages || []
      this.requestUpdate()
    } catch {}
  }

  // ---- 老账本轮询模式（dws 等载体）----
  async load() {
    if (this._loading) return
    this._loading = true
    this.loading = true
    try {
      const res = await fetch(this.conv ? `/api/chat?conv=${encodeURIComponent(this.conv)}` : "/api/chat", { cache: "no-store" })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.conversationOld = body
      this.error = ""
    } catch (error) {
      this.error = this.conv ? `拿不到会话 ${this.conv}：${error.message}` : `拿不到 Router Agent 会话：${error.message}`
    } finally {
      this._loading = false
      this.loading = false
    }
  }

  // ---- 滚动到底部：滚离底部 240px 出现悬浮按钮，点击回底 ----
  _onScroll(event) {
    const el = event.target
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 240
    if (far !== this.showJump) {
      this.showJump = far
      this.requestUpdate()
    }
  }

  _jumpBottom() {
    const el = this.querySelector(".chat-messages")
    if (el) el.scrollTop = el.scrollHeight
    this.showJump = false
  }

  // ---- 斜杠命令：草稿以 / 开头弹菜单；send 时拦截分发 ----
  _slashMatches() {
    const prefix = this.slash.slice(1).trim().toLowerCase()
    return SLASH_COMMANDS.filter((c) => !prefix || c.cmd.startsWith(prefix))
  }

  _runSlash(cmd) {
    if (cmd === "clear") return this.doClear()
  }

  async doClear() {
    if (this.busy) return
    if (this.streamMode ? this._readOnly : Boolean(this.conv)) {
      this.error = "/clear 只作用于 Router 会话；正在围观子智能体，切回 Router 再试。"
      return
    }
    this.busy = true
    this.error = ""
    try {
      const res = await fetch("/api/chat/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.draft = ""
      this.slash = ""
      this.notice = `已新建 Router 会话${body.name ? `「${body.name}」` : ""}；旧会话还在列表里，可手动归档`
      // 现场清空重连：conv="" 的快照会解析到新会话。
      this._reset()
      if (this.streamMode) this._connectStream()
      else this.load()
      this._loadPending()
    } catch (e) {
      this.error = `/clear 失败：${e.message}`
    } finally {
      this.busy = false
    }
  }

  async send() {
    const text = this.draft.trim()
    if (!text || this.busy) return
    if (text.startsWith("/")) {
      const cmd = text.slice(1).split(/\s+/)[0].toLowerCase()
      const known = SLASH_COMMANDS.some((c) => c.cmd === cmd)
      if (!known) {
        this.error = `未知命令 /${cmd}；可用：${SLASH_COMMANDS.map((c) => `/${c.cmd}`).join("、")}`
        return
      }
      return this._runSlash(cmd)
    }
    if (this.streamMode ? this._readOnly : Boolean(this.conv)) {
      this.error = "只读围观：发送只进 Router。切回「Router（当前）」再发消息。"
      return
    }
    this.busy = true
    this.error = ""
    this.notice = ""
    try {
      const clientId = globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, clientId }),
      })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.draft = ""
      this._sending = true
      this.notice = body.status === "dropped" ? "重复消息已忽略" : "消息已写入 Inbox，投递后会出现在下方"
      this._loadPending()
      emit(this, "chat-sent", { eventId: body.eventId })
    } catch (error) {
      this.error = `发送失败：${error.message}`
    } finally {
      this.busy = false
    }
  }

  // ---- 渲染 ----
  _cleanText(text) {
    return String(text ?? "").replaceAll(CHAT_UI_MARKER, "").trim()
  }

  _sortedMessages() {
    return [...this._msgById.values()].sort((a, b) => a.timeCreated - b.timeCreated || (a.id < b.id ? -1 : 1))
  }

  _partsOf(messageId) {
    return [...this._partById.values()]
      .filter((p) => p.messageId === messageId)
      .sort((a, b) => a.timeCreated - b.timeCreated || (a.id < b.id ? -1 : 1))
  }

  _renderPart(part, { live, isTail }) {
    if (part.type === "text") {
      return html`<div class="chat-text">${this._cleanText(part.text)}</div>`
    }
    if (part.type === "reasoning") {
      const thinking = live && isTail
      return html`<details class="chat-event chat-part chat-part-reasoning">
        <summary><span class="part-tag">思考</span>${thinking ? html`<span class="chat-live-text">思考中…</span>` : "过程"}</summary>
        <pre>${this._cleanText(part.text)}</pre>
      </details>`
    }
    if (part.type === "tool") {
      const label = TOOL_STATUS[part.status] || part.status || "工具"
      return html`<details class="chat-event chat-part chat-part-tool">
        <summary>
          <span class=${`part-dot ${part.status === "running" || part.status === "pending" ? "is-run" : part.status === "error" ? "is-err" : "is-done"}`}></span>
          <span class="part-tag">${part.tool || "工具"}</span>
          <span>${label}</span>
        </summary>
        <pre>${part.stateText || "（无输出）"}</pre>
      </details>`
    }
    return html`<details class="chat-event chat-part">
      <summary><span class="part-tag">${part.type || "块"}</span></summary>
      <pre>${JSON.stringify(part, null, 2)}</pre>
    </details>`
  }

  _renderStreamMessage(message, index, total) {
    const own = message.role === "user"
    const parts = this._partsOf(message.id).filter((p) => p.type !== "step-start" && p.type !== "step-finish")
    const isLast = index === total - 1
    const live = isLast && (!message.completed || this._running)
    const texts = parts.filter((p) => p.type === "text")
    const extras = parts.filter((p) => p.type !== "text")
    const bubble = html`
      ${own ? html`<div class="chat-bubble">${texts.map((p) => html`<div class="chat-text">${this._cleanText(p.text)}</div>`)}</div>`
      : html`<div class="chat-bubble is-stream">
        ${extras.map((p, i) => this._renderPart(p, { live, isTail: live && i === extras.length - 1 }))}
        ${texts.length ? texts.map((p) => html`<div class="chat-text">${this._cleanText(p.text)}</div>`) : ""}
        ${!parts.length && live ? html`<div class="chat-live-text">正在生成…</div>` : ""}
      </div>`}`
    return html`<div class=${`chat-message ${own ? "is-own" : "is-agent"}`}>
      <span class="chat-avatar">${own ? "你" : "R"}</span>
      <div class="chat-content">
        <div class="chat-meta">${own ? "你" : this._title || "Router Agent"}${message.model && !own ? html` <span class="chat-meta-model">${message.model}</span>` : ""}</div>
        ${bubble}
        ${message.error ? html`<div class="chat-error">${message.error}</div>` : ""}
      </div>
    </div>`
  }

  _renderLegacyMessage(message, agentTitle = "Router Agent") {
    if (message.role === "event") {
      return html`<details class="chat-event">
        <summary>Foreman 事件</summary>
        <pre>${message.text}</pre>
      </details>`
    }
    const own = message.role === "user"
    return html`<div class=${`chat-message ${own ? "is-own" : "is-agent"}`}>
      <span class="chat-avatar">${own ? "你" : "R"}</span>
      <div class="chat-content">
        <div class="chat-meta">${own ? "你" : agentTitle}</div>
        <div class="chat-bubble">${message.text}</div>
        ${message.finished === false ? html`<div class="chat-meta">正在回复…</div>` : ""}
        ${message.error ? html`<div class="chat-error">${message.error}</div>` : ""}
      </div>
    </div>`
  }

  render() {
    if (!this.streamMode) return this._renderLegacy()
    const messages = this._sortedMessages()
    const watching = Boolean(this.conv)
    const pendingMessages = this._pendingMessages
    return html`<section class="panel chat-panel">
      <div class="chat-messages" aria-live="polite" @scroll=${this._onScroll}>
        ${messages.length ? messages.map((m, i) => this._renderStreamMessage(m, i, messages.length)) : html`
          <div class="chat-empty">
            ${watching
              ? html`<strong>这条会话还没有转录</strong><span>智能体开始干活后，推理 / 正文 / 工具调用会逐块实时出现。</span>`
              : html`<strong>给 Router Agent 发一条消息</strong><span>消息先写入 Inbox，再由 Worker 投递；它会在这里逐块实时跑给你看。</span>`}
          </div>`}
        ${this._running || (messages.at(-1)?.role === "assistant" && !messages.at(-1)?.completed)
          ? html`<div class="chat-streaming-hint"><span class="chat-live-dot"></span>正在生成——推理与工具调用逐块落库，秒级可见</div>`
          : ""}
      </div>
      ${this.showJump ? html`<button class="chat-jump" type="button" @click=${this._jumpBottom} aria-label="滚动到底部">↓ 到底</button>` : ""}
      ${this.notice ? html`<div class="chat-notice">${this.notice}</div>` : ""}
      ${this.error ? html`<div class="chat-error chat-load-error">${this.error}</div>` : ""}
      ${this._readOnly ? html`<div class="chat-readonly-chip">只读围观 · 子智能体会话（发送只进 Router）</div>` : ""}
      ${!watching && pendingMessages.length ? html`<div class="chat-pending-queue" aria-label="等待投送的消息" aria-live="polite">
        ${pendingMessages.map((message) => html`<div class="chat-pending-message">
          <svg class="chat-pending-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 5.5h12M4 10h8M4 14.5h5M13 13l2 2 3-4" />
          </svg>
          <span class="chat-pending-text" title=${message.text}>${message.text}</span>
          <span class="chat-pending-status">${message.status === "processing" ? "投送中" : "待投送"}</span>
        </div>`)}
      </div>` : ""}
      ${this.slash !== "" && !this._readOnly ? html`<div class="chat-slash" role="listbox" aria-label="斜杠命令">
        ${this._slashMatches().map((c) => html`<button type="button" class="chat-slash-item" @click=${() => { this.draft = ""; this.slash = ""; this._runSlash(c.cmd) }}>
          <span class="chat-slash-cmd">/${c.cmd}</span><span class="chat-slash-desc">${c.desc}</span>
        </button>`)}
        ${this._slashMatches().length ? "" : html`<div class="chat-slash-empty">没有匹配的命令</div>`}
      </div>` : ""}
      ${this._readOnly ? "" : html`<form class="chat-composer" @submit=${(event) => { event.preventDefault(); this.send() }}>
        <textarea
          rows="2"
          placeholder="给 Router Agent 发消息…（/ 唤起命令）"
          .value=${this.draft}
          ?disabled=${this.busy}
          @input=${(event) => { this.draft = event.target.value; this.slash = event.target.value.startsWith("/") ? event.target.value : "" }}
          @keydown=${(event) => {
            // IME 组字时的 Enter 是选词上屏（keyCode 229 兼容部分 WebView），
            // 不 preventDefault、不发送，交给输入法。
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              this.send()
            }
          }}
        ></textarea>
        <div class="chat-composer-foot">
          <span>Enter 发送 · Shift+Enter 换行${this._transport === "poll" ? " · 轮询模式" : " · 实时流"}</span>
          <button class="primary" type="submit" ?disabled=${this.busy || !this.draft.trim()}>
            ${this.busy ? "写入中…" : "发送"}
          </button>
        </div>
      </form>`}
    </section>`
  }

  _renderLegacy() {
    const rawMessages = this.conversationOld?.messages || []
    const messages = rawMessages.map((message, index) => ({
      ...message,
      finished: message.role === "assistant" && index < rawMessages.length - 1 ? true : message.finished,
    }))
    if (this.conversationOld?.running && messages.at(-1)?.finished !== false) {
      messages.push({ id: "awaiting-router-reply", role: "assistant", text: "", finished: false })
    }
    const pendingMessages = this.conversationOld?.pendingMessages || []
    const watching = Boolean(this.conv)
    const title = watching ? (this.conversationOld?.name || this.conv) : "Router Agent"
    return html`<section class="panel chat-panel">
      <div class="chat-messages" aria-live="polite">
        ${messages.length ? messages.map((message) => this._renderLegacyMessage(message, title)) : html`
          <div class="chat-empty">
            ${watching
              ? html`<strong>这条会话还没有留痕对话</strong><span>首轮运行结束后这里会显示每轮的派活与回复。</span>`
              : html`<strong>给 Router Agent 发一条消息</strong><span>消息先写入 Inbox，再由 Worker 投递；服务重启后仍可恢复。</span>`}
          </div>`}
      </div>
      ${this.notice ? html`<div class="chat-notice">${this.notice}</div>` : ""}
      ${this.error ? html`<div class="chat-error chat-load-error">${this.error}</div>` : ""}
      ${!watching && pendingMessages.length ? html`<div class="chat-pending-queue" aria-label="等待投送的消息" aria-live="polite">
        ${pendingMessages.map((message) => html`<div class="chat-pending-message">
          <svg class="chat-pending-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 5.5h12M4 10h8M4 14.5h5M13 13l2 2 3-4" />
          </svg>
          <span class="chat-pending-text" title=${message.text}>${message.text}</span>
          <span class="chat-pending-status">${message.status === "processing" ? "投送中" : "待投送"}</span>
        </div>`)}
      </div>` : ""}
      <form class="chat-composer" @submit=${(event) => { event.preventDefault(); this.send() }}>
        <textarea
          rows="2"
          placeholder="给 Router Agent 发消息…"
          .value=${this.draft}
          ?disabled=${this.busy}
          @input=${(event) => { this.draft = event.target.value }}
          @keydown=${(event) => {
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              this.send()
            }
          }}
        ></textarea>
        <div class="chat-composer-foot">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <button class="primary" type="submit" ?disabled=${this.busy || !this.draft.trim()}>
            ${this.busy ? "写入中…" : "发送"}
          </button>
        </div>
      </form>
    </section>`
  }
}

customElements.define("fm-chat", FmChat)
