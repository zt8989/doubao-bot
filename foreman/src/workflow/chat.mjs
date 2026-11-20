import { Book } from "../book.mjs"
import { routerOnce } from "../core/router.mjs"

const CHAT_KIND = "chat.message"
const CHAT_SOURCE = "chat-ui"

function cleanClientId(value) {
  const id = String(value ?? "").trim()
  if (!id) return ""
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) throw new Error("clientId 只能包含字母、数字、点、下划线、冒号或连字符，最长 128 位")
  return id
}

function chatRole(message) {
  if (message.role === "assistant") return "assistant"
  return String(message.text ?? "").includes("【Chat UI 用户消息】") ? "user" : "event"
}

function chatText(message) {
  const text = String(message.text ?? "")
  if (chatRole(message) !== "user") return text
  const marker = "【Chat UI 用户消息】"
  return text.slice(text.indexOf(marker) + marker.length).trim()
}

/**
 * Chat 是外围 workflow：写消息只进入 durable Inbox；Worker 调用 deliver 后才投递 router agent。
 * core 不知道浏览器、输入框或会话展示，Chat 也不绕过 core 的幂等、恢复和串行调度。
 */
export function createChatWorkflow(ctx) {
  return {
    async send({ text, clientId } = {}) {
      const message = String(text ?? "").trim()
      if (!message) throw new Error("消息不能为空")
      if (message.length > 100000) throw new Error("单条消息不能超过 100000 个字符")
      if (!ctx.inbox) throw new Error("Chat 缺少 Inbox，消息未发送")
      const id = cleanClientId(clientId)
      const result = ctx.inbox.enqueue({
        kind: CHAT_KIND,
        text: message,
        payload: { source: CHAT_SOURCE, clientId: id, sentAt: new Date().toISOString() },
        dedupeKey: id ? `chat:message:${id}` : "",
        dedupeMode: "forever",
      })
      return { ok: true, eventId: result.id, status: result.status, ...(result.reason ? { reason: result.reason } : {}) }
    },

    async deliver(events) {
      const batch = Array.isArray(events) ? events : [events]
      const notices = batch.filter(Boolean).map((event) => `【Chat UI 用户消息】\n${String(event.text ?? "").trim()}`)
      if (!notices.length) return { ok: true, skipped: "empty" }
      const result = await routerOnce(ctx, { force: true, scheduled: false, notices })
      if (!result.ok || result.skipped) throw new Error(result.error || `Router Agent 暂时不可投递：${result.skipped}`)
      return result
    },

    async messages() {
      const book = new Book(ctx.cfg.stateFile)
      const router = book.data.router ?? book.data.inspector ?? {}
      const pendingMessages = (ctx.inbox
        ? [...ctx.inbox.list({ limit: 1000, status: "pending" }), ...ctx.inbox.list({ limit: 1000, status: "processing" })]
        : [])
        .filter((event) => event.kind === CHAT_KIND)
        .sort((a, b) => a.id - b.id)
        .map((event) => ({ id: event.id, text: String(event.text ?? ""), status: event.status }))
      const pending = pendingMessages.length
      if (!router.convId) return { ok: true, convId: "", name: "", messages: [], running: false, pending, pendingMessages }
      if (typeof ctx.dws?.info !== "function") throw new Error("dws 缺少 info，无法读取 Router Agent 会话")
      const info = await ctx.dws.info(router.convId)
      const raw = Array.isArray(info?.messages) ? info.messages : []
      const messages = raw.map((message, index) => ({
        id: String(message.id || `${index}`),
        role: chatRole(message),
        text: chatText(message),
        finished: message.finished !== false,
        ...(message.error ? { error: String(message.error) } : {}),
      }))
      const last = messages[messages.length - 1]
      return {
        ok: true,
        convId: String(router.convId),
        name: String(router.name ?? ""),
        messages,
        pending,
        pendingMessages,
        running: Boolean(last && (last.role !== "assistant" || last.finished === false)),
      }
    },
  }
}
