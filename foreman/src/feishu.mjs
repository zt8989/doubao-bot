// 飞书入站通道（openclaw 式）：官方 SDK 的 WS 长连接收 im.message.receive_v1，
// 按白名单/群分级筛选后写成 Inbox 的 chat.message 事件——之后复用现有链路
// （Worker → chat.deliver → routerOnce → router agent），本文件不碰会话编排。
// 回复推送（FeishuReplyPump）轮询 router 会话的 assistant 增量，经 Outbox lark 渠道发回飞书；
// 出站仍走 lark-cli，SDK 凭据只管入站订阅。
//
// service 里 enabled 才动态 import 本文件，feishu.enabled=false 的机器零加载 SDK。
import { AppType, Client, Domain, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk"
import { Book } from "./book.mjs"
import { enqueueOutbound } from "./outbound.mjs"
import { nowIso } from "./util.mjs"

// 回复推送的单条长度上限：飞书消息太长会被服务端拒绝，超限截断并注明。
const MAX_PUSH_CHARS = 4000

// WS 重连会重投事件，按 message_id 做带 TTL 的 LRU 去重（同 openclaw 的 MessageDedup）。
export class MessageDedup {
  constructor({ ttlMs = 300000, maxEntries = 5000 } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.seen = new Map()
  }

  // true = 第一次见（放行）；false = TTL 内重复（拦截）。
  check(id) {
    const key = String(id ?? "").trim()
    if (!key) return true
    const now = Date.now()
    if (this.seen.size > this.maxEntries) {
      for (const [k, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(k)
    }
    const prev = this.seen.get(key)
    if (prev !== undefined && now - prev <= this.ttlMs) return false
    this.seen.set(key, now)
    return true
  }
}

// 入站分类（纯函数，供 Gateway 与测试共用）：按私聊白名单 + 群分级决定收不收。
// event 是 im.message.receive_v1 事件体：{ sender: { sender_id }, message: { chat_type, chat_id, message_id, message_type, mentions, body } }。
// identity 是机器人自己的标识：{ botName?, botOpenId? }，低优群靠它认 @机器人。
export function classifyInbound(feishuCfg, event, identity = {}) {
  const message = event?.message ?? {}
  const chatType = String(message.chat_type ?? "")
  const chatId = String(message.chat_id ?? "")
  const messageId = String(message.message_id ?? "").trim()
  const sender = event?.sender?.sender_id ?? {}
  const senderId = String(sender.open_id ?? sender.user_id ?? sender.union_id ?? "").trim()
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const deny = (reason) => ({ accept: false, reason, messageId })

  // 只有文本能读出正文；图片/文件/富文本先拒收（提示原因，后续要再说）。
  let text = ""
  if (String(message.message_type ?? "") === "text") {
    try {
      text = String(JSON.parse(message.body?.content ?? "{}").text ?? "")
    } catch {
      text = ""
    }
    // 正文里的 @占位符（@_user_1）替换成 mention 名字，agent 看到的是人话。
    for (const m of mentions) {
      if (m?.key) text = text.split(String(m.key)).join(`@${String(m?.name ?? "").trim()}`)
    }
    text = text.trim()
  }

  if (!messageId) return deny("缺 message_id")
  if (!text) return deny(`暂只收文本消息（收到 ${message.message_type || "未知类型"}）`)

  if (chatType === "p2p") {
    if (!feishuCfg.allowUsers.includes(senderId)) return deny("私聊发送者不在 feishu.allowUsers 白名单")
    return { accept: true, chatType, chatId, senderId, messageId, text }
  }
  if (chatType === "group") {
    if (feishuCfg.groups.high.includes(chatId)) return { accept: true, chatType, chatId, senderId, messageId, text }
    if (feishuCfg.groups.low.includes(chatId)) {
      // @机器人：按 open_id 或名字认 mention；两个都没配就认不出来。
      const atBot = mentions.some(
        (m) =>
          (identity.botOpenId && String(m?.id?.open_id ?? "") === identity.botOpenId) ||
          (identity.botName && String(m?.name ?? "").trim() === identity.botName)
      )
      if (!atBot) return deny("低优群只有 @机器人 才收（配 feishu.botName 或 botOpenId 认 @）")
      return { accept: true, chatType, chatId, senderId, messageId, text }
    }
    return deny("群不在 feishu.groups.high/low 名单")
  }
  return deny(`未知会话类型：${chatType || "缺 chat_type"}`)
}

// 账本里的飞书通道状态（回复目标 + 推送断点），重启不丢。
function feishuState(book) {
  return book.data.feishu ?? (book.data.feishu = {})
}

export class FeishuGateway {
  constructor({ cfg, ctx, log = () => {} } = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.log = log
    this.feishuCfg = cfg.feishu ?? {}
    this.dedup = new MessageDedup()
    this.ws = null
    this.status = { running: false, error: "", lastInboundAt: "", accepted: 0, rejected: 0, duplicates: 0 }
  }

  async start() {
    const { appId, appSecret } = this.feishuCfg
    // 凭据不在界面填（config.json feishu 段一次性配置）：没配就明确报错，别让 SDK 自己吐晦涩日志。
    if (!appId || !appSecret) throw new Error("飞书应用凭据未配置：在 config.json 的 feishu.appId/appSecret 里填一次（之后只用扫码授权）")
    const domain = this.feishuCfg.domain === "lark" ? Domain.Lark : Domain.Feishu
    // 自定义 logger 只留 error：SDK 的 info/warn 会把横幅刷进 service.log / stdout。
    const logger = { info: () => {}, warn: () => {}, error: (...args) => this.log(`飞书 WS 错误：${args.join(" ")}`) }
    const client = new Client({ appId, appSecret, appType: AppType.SelfBuild, domain, logger })
    this.client = client
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": (data) => this.onMessage(data),
    })
    const ws = new WSClient({ appId, appSecret, domain, logger })
    this.ws = ws
    await ws.start({ eventDispatcher: dispatcher })
    this.status.running = true
    this.status.error = ""
    this.log(`飞书通道已启动：${appId}（长连接收消息，私聊 ${this.feishuCfg.allowUsers.length} 人 · 高优群 ${this.feishuCfg.groups.high.length} · 低优群 ${this.feishuCfg.groups.low.length}）`)
  }

  stop() {
    try {
      this.ws?.close({ force: true })
    } catch {}
    this.status.running = false
  }

  view() {
    return { enabled: this.feishuCfg.enabled === true, ...this.status }
  }

  async onMessage(data) {
    try {
      const verdict = classifyInbound(this.feishuCfg, data, {
        botOpenId: this.feishuCfg.botOpenId,
        botName: this.feishuCfg.botName,
      })
      this.status.lastInboundAt = nowIso()
      if (!verdict.accept) {
        this.status.rejected++
        this.log(`飞书消息不收：${verdict.reason}（${verdict.messageId || "无 id"}）`)
        return
      }
      if (!this.dedup.check(verdict.messageId)) {
        this.status.duplicates++
        return
      }
      this.status.accepted++
      // 回复目标跟着来源走：私聊发回发件人，群聊发回群；console/chat-ui 来的消息不改目标。
      const book = new Book(this.cfg.stateFile)
      const st = feishuState(book)
      st.replyTarget = verdict.chatType === "p2p" ? { kind: "user", id: verdict.senderId } : { kind: "chat", id: verdict.chatId }
      st.lastInboundAt = nowIso()
      book.save()
      // client 格式与 chat.send 的 cleanClientId 兼容（字母数字._:-），复用同一套去重与 UI 口径。
      const clientId = `feishu-${verdict.messageId}`.slice(0, 128)
      this.ctx.inbox.enqueue({
        kind: "chat.message",
        text: verdict.text,
        payload: {
          source: "feishu",
          chatType: verdict.chatType,
          chatId: verdict.chatId,
          senderId: verdict.senderId,
          clientId,
          sentAt: nowIso(),
        },
        dedupeKey: `chat:message:${clientId}`,
        dedupeMode: "forever",
      })
      this.log(`飞书消息已入箱：${verdict.chatType} ${verdict.messageId.slice(-8)}（${verdict.text.length} 字）`)
    } catch (e) {
      this.log(`飞书消息处理失败：${e.message}`)
    }
  }
}

// 回复推送：轮询 router 会话，把新完成的 assistant 回复经 Outbox lark 渠道发回飞书。
// console Chat 页是拉模式（自己轮询会话内容），飞书侧必须推，所以单独要这个泵。
export class FeishuReplyPump {
  constructor({ cfg, ctx, log = () => {} } = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.log = log
    this.timer = null
    this.running = false
    this.lastResult = null
  }

  start() {
    const seconds = Number(this.cfg.feishu?.replyPollSeconds ?? 5)
    this.timer = setInterval(() => {
      this.pollOnce().catch((e) => {
        this.lastResult = { ok: false, error: e.message }
        this.log(`飞书回复推送失败：${e.message}`)
      })
    }, seconds * 1000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  state() {
    const book = new Book(this.cfg.stateFile)
    return { book, st: feishuState(book) }
  }

  async pollOnce() {
    if (this.running) return { ok: true, skipped: "busy" }
    this.running = true
    try {
      const { book, st } = this.state()
      // 还没从飞书收过消息就没有推送目标（飞书回复只发给飞书来过的会话）。
      const target = st.replyTarget
      if (!target?.id) return { ok: true, skipped: "no-target" }
      const base = await this.ctx.chat.messagesBase()
      if (!base?.convId) return { ok: true, skipped: "no-session" }
      const replies = (base.messages ?? []).filter(
        (m) => m.role === "assistant" && m.finished !== false && String(m.text ?? "").trim()
      )
      if (!replies.length) return { ok: true, skipped: "empty" }

      const lastId = String(st.lastPushedId ?? "")
      const idx = lastId ? replies.findIndex((m) => String(m.id) === lastId) : -1
      if (idx < 0) {
        // 首次启用或会话重建：锚定最新一条、不回放历史，之后的才是增量（重启/换会话当刻的第一条回复可能被吞，README 有说明）。
        st.lastPushedId = String(replies[replies.length - 1].id)
        book.save()
        this.lastResult = { ok: true, skipped: "armed" }
        return this.lastResult
      }
      const fresh = replies.slice(idx + 1)
      if (!fresh.length) return { ok: true, skipped: "no-new" }
      for (const m of fresh) {
        const text = String(m.text).trim()
        const body = text.length > MAX_PUSH_CHARS ? `${text.slice(0, MAX_PUSH_CHARS)}\n…（已截断，完整内容见控制台）` : text
        enqueueOutbound(
          this.ctx,
          target.kind === "user"
            ? { type: "lark", input: { userId: target.id, markdown: body }, dedupeKey: `feishu:push:${m.id}` }
            : { type: "lark", input: { chatId: target.id, markdown: body }, dedupeKey: `feishu:push:${m.id}` }
        )
      }
      st.lastPushedId = String(fresh[fresh.length - 1].id)
      book.save()
      this.lastResult = { ok: true, pushed: fresh.length }
      return this.lastResult
    } finally {
      this.running = false
    }
  }
}
