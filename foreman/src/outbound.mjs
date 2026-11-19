// 统一外发入口：send --type mail|lark → Outbox。
import { withSessionRoute } from "./mail.mjs"
// 这里只校验并持久化，不调用外部 CLI；实际发送由 Dispatcher 的通道 adapter 完成。
export function outboundPayload(type, input = {}) {
  const channel = String(type ?? "").trim().toLowerCase()
  if (channel === "mail") {
    const to = (Array.isArray(input.to) ? input.to : String(input.to ?? "").split(/[,，;；\s]+/))
      .map((value) => String(value ?? "").trim()).filter(Boolean)
    const subject = String(input.subject ?? "").trim()
    if (!to.length) throw new Error("send --type mail 需要 --to <邮箱>，多个用逗号分隔")
    if (!subject) throw new Error("send --type mail 需要 --subject <主题>")
    const sessionId = String(input.sessionId ?? "").trim()
    return { channel, payload: { to, subject: withSessionRoute(subject, sessionId), body: String(input.body ?? ""), ...(sessionId ? { sessionId } : {}) } }
  }
  if (channel === "lark") {
    const chatId = String(input.chatId ?? "").trim()
    const userId = String(input.userId ?? "").trim()
    const text = String(input.text ?? "")
    const markdown = String(input.markdown ?? "")
    if (Boolean(chatId) === Boolean(userId)) throw new Error("send --type lark 的 --chat-id 与 --user-id 必须且只能提供一个")
    if (Boolean(text.trim()) === Boolean(markdown.trim())) throw new Error("send --type lark 的 --text 与 --markdown 必须且只能提供一个")
    return { channel, payload: { chatId, userId, ...(text.trim() ? { text } : { markdown }) } }
  }
  throw new Error("send 需要 --type mail|lark")
}

export function enqueueOutbound(ctx, { type, input = {}, dedupeKey = "" } = {}) {
  if (typeof ctx?.outbox?.enqueue !== "function") throw new Error("Outbox 不可用：请先启动 foreman serve")
  const { channel, payload } = outboundPayload(type, input)
  const event = ctx.outbox.enqueue({
    channel, payload, dedupeKey,
    maxAttempts: Number(ctx.cfg?.outbox?.maxAttempts ?? 8),
  })
  return { ...event, type: channel }
}
