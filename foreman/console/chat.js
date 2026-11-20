import { LitElement, html } from "lit"

const emit = (host, name, detail) =>
  host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))

class FmChat extends LitElement {
  static properties = {
    conversation: { attribute: false },
    draft: { type: String },
    busy: { type: Boolean },
    loading: { type: Boolean },
    error: { type: String },
    notice: { type: String },
  }

  constructor() {
    super()
    this.conversation = { messages: [], running: false }
    this.draft = ""
    this.busy = false
    this.loading = false
    this.error = ""
    this.notice = ""
    this._timer = null
    this._loading = false
    this._follow = false
    this._sawActivity = false
  }

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    this.load()
    this._timer = setInterval(() => {
      if (!document.hidden && this._follow) this.load()
    }, 3000)
  }

  disconnectedCallback() {
    clearInterval(this._timer)
    this._timer = null
    super.disconnectedCallback()
  }

  updated() {
    const list = this.querySelector(".chat-messages")
    if (list) list.scrollTop = list.scrollHeight
    // 把 chat 状态冒泡到 <fm-console>，由顶栏 fm-head 渲染（顶栏融合）。
    emit(this, "chat-state", {
      running: !!this.conversation?.running,
      pending: !!this.conversation?.pending,
      loading: !!this.loading,
    })
  }

  async load() {
    if (this._loading) return
    this._loading = true
    this.loading = true
    try {
      const res = await fetch("/api/chat", { cache: "no-store" })
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.message || `HTTP ${res.status}`)
      this.conversation = body
      if (body.pending > 0 || body.running) {
        this._follow = true
        this._sawActivity = true
      } else if (this._follow && this._sawActivity) {
        this._follow = false
        this._sawActivity = false
        this.notice = ""
      }
      this.error = ""
    } catch (error) {
      this.error = `拿不到 Router Agent 会话：${error.message}`
    } finally {
      this._loading = false
      this.loading = false
    }
  }

  async send() {
    const text = this.draft.trim()
    if (!text || this.busy) return
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
      this._follow = body.status !== "dropped"
      this._sawActivity = false
      this.notice = body.status === "dropped" ? "重复消息已忽略" : "消息已写入 Inbox，Worker 正在投递"
      await this.load()
      emit(this, "chat-sent", { eventId: body.eventId })
    } catch (error) {
      this.error = `发送失败：${error.message}`
    } finally {
      this.busy = false
    }
  }

  renderMessage(message) {
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
        <div class="chat-meta">${own ? "你" : "Router Agent"}</div>
        <div class="chat-bubble">${message.text}</div>
        ${message.finished === false ? html`<div class="chat-meta">正在回复…</div>` : ""}
        ${message.error ? html`<div class="chat-error">${message.error}</div>` : ""}
      </div>
    </div>`
  }

  render() {
    const rawMessages = this.conversation?.messages || []
    const messages = rawMessages.map((message, index) => ({
      ...message,
      finished: message.role === "assistant" && index < rawMessages.length - 1 ? true : message.finished,
    }))
    if (this.conversation?.running && messages.at(-1)?.finished !== false) {
      messages.push({ id: "awaiting-router-reply", role: "assistant", text: "", finished: false })
    }
    const pendingMessages = this.conversation?.pendingMessages || []
    return html`<section class="panel chat-panel">
      <div class="chat-messages" aria-live="polite">
        ${messages.length ? messages.map((message) => this.renderMessage(message)) : html`
          <div class="chat-empty">
            <strong>给 Router Agent 发一条消息</strong>
            <span>消息先写入 Inbox，再由 Worker 投递；服务重启后仍可恢复。</span>
          </div>`}
      </div>
      ${this.notice ? html`<div class="chat-notice">${this.notice}</div>` : ""}
      ${this.error ? html`<div class="chat-error chat-load-error">${this.error}</div>` : ""}
      ${pendingMessages.length ? html`<div class="chat-pending-queue" aria-label="等待投送的消息" aria-live="polite">
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
          rows="3"
          placeholder="给 Router Agent 发消息…"
          .value=${this.draft}
          ?disabled=${this.busy}
          @input=${(event) => { this.draft = event.target.value }}
          @keydown=${(event) => {
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
