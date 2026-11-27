// 飞书入站通道（openclaw 式）：官方 SDK 的 WS 长连接收 im.message.receive_v1，
// 按白名单/群分级筛选后写成 Inbox 的 chat.message 事件——之后复用现有链路
// （Worker → chat.deliver → routerOnce → router agent），本文件不碰会话编排。
// 回复发到哪由 router agent 看投递包装里的来源说明自己决定，调 foreman send 入 Outbox
// （feishu 渠道直发，见 workflow/chat.mjs 的 noticeOf 与 sendOutbound）；机器人自己外发的
// 消息按 sender=botOpenId 拦回声，防直发循环。出站与入站同一个 app（open_id/chat_id
// 都是 app 作用域的，换 app 发会报 open_id cross app）。
//
// service 里 enabled 才动态 import 本文件，feishu.enabled=false 的机器零加载 SDK。
import { AppType, Client, Domain, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk"
import { Book } from "./book.mjs"
import { enqueueOutbound } from "./outbound.mjs"
import { nowIso } from "./util.mjs"

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
  // content 位置两套形状：webhook 是 message.body.content；WS 长连接解包后直接是 message.content。
  let text = ""
  if (String(message.message_type ?? "") === "text") {
    try {
      text = String(JSON.parse(message.content ?? message.body?.content ?? "{}").text ?? "")
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

  // 机器人自己外发的消息会从 WS 原样回声进来（agent 直发配方后 p2p 回声全过白名单）：
  // 按 sender=botOpenId 拦掉，防止「自己回复自己」的循环。botOpenId 没拿到时退化为旧行为。
  if (identity.botOpenId && senderId === identity.botOpenId) {
    return deny("机器人自己的消息（外发回声，拦截防循环）")
  }

  if (chatType === "p2p") {
    // allowUsers 留空 = 放行所有私聊（单管理员自用默认）；配了就只放名单内。
    if (feishuCfg.allowUsers.length && !feishuCfg.allowUsers.includes(senderId)) {
      return deny("私聊发送者不在 feishu.allowUsers 白名单")
    }
    return { accept: true, chatType, chatId, senderId, messageId, text }
  }
  if (chatType === "group") {
    // 群聊两级口径：groups.high 全收；其余群默认只有 @机器人才收。
    if (feishuCfg.groups.high.includes(chatId)) return { accept: true, chatType, chatId, senderId, messageId, text }
    const atBot = mentions.some(
      (m) =>
        (identity.botOpenId && String(m?.id?.open_id ?? "") === identity.botOpenId) ||
        (identity.botName && String(m?.name ?? "").trim() === identity.botName)
    )
    if (!atBot) return deny("群聊未 @机器人（默认只有 @ 才收；要全收把群配进 feishu.groups.high）")
    return { accept: true, chatType, chatId, senderId, messageId, text }
  }
  return deny(`未知会话类型：${chatType || "缺 chat_type"}`)
}

// 账本里的飞书通道状态（诊断留痕：最近回复目标 + 最近入站时间），重启不丢。
// 回复推送不再由确定性泵代推：deliver 包装带来源说明与建议命令，router agent 自己
// 调 foreman send 入 Outbox（见 workflow/chat.mjs noticeOf）。
function feishuState(book) {
  return book.data.feishu ?? (book.data.feishu = {})
}

// bot info 响应 → open_id。真实响应形状是顶层 bot.open_id（data 下没有），data 兜底只为兼容旧版。
export function botOpenIdFromInfo(payload) {
  return String(payload?.bot?.open_id ?? payload?.data?.open_id ?? "").trim()
}

export class FeishuGateway {
  constructor({ cfg, ctx, log = () => {} } = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.log = log
    this.feishuCfg = cfg.feishu ?? {}
    this.dedup = new MessageDedup()
    this.ws = null
    this.status = { running: false, error: "", lastInboundAt: "", accepted: 0, rejected: 0, duplicates: 0, processing: null }
  }

  // bot 处理状态：worker 认领到飞书消息即点亮（控制台 IM 页可见「处理中：…」），
  // bot 的回复经 Outbox 送出后由 Dispatcher 熄灭；投递失败也熄灭（重试认领会重新点亮）。
  markProcessing(events = []) {
    const list = (Array.isArray(events) ? events : [events]).filter((e) => e?.payload?.source === "feishu" && e?.payload?.chatId)
    if (!list.length) return
    const last = list[list.length - 1]
    this.status.processing = {
      chatId: String(last.payload.chatId),
      chatType: String(last.payload.chatType || ""),
      senderId: String(last.payload.senderId || ""),
      text: String(last.text || "").slice(0, 60),
      since: nowIso(),
    }
  }

  clearProcessing() {
    this.status.processing = null
  }

  async start() {
    const { appId, appSecret } = this.feishuCfg
    // 凭据不在界面填（config.json feishu 段一次性配置）：没配就明确报错，别让 SDK 自己吐晦涩日志。
    if (!appId || !appSecret) throw new Error("飞书应用凭据未配置：在 config.json 的 feishu.appId/appSecret 里填一次（之后只用扫码授权）")
    const domain = this.feishuCfg.domain === "lark" ? Domain.Lark : Domain.Feishu
    // 自定义 logger 只留 warn/error：SDK 的 info 会把横幅刷进 service.log / stdout，
    // 但 warn 要留——事件解密失败、无 handler 被丢弃时 SDK 只发 warn，静音了就完全失明。
    const logger = {
      info: () => {},
      warn: (...args) => this.log(`飞书 SDK：${args.join(" ")}`),
      error: (...args) => this.log(`飞书 WS 错误：${args.join(" ")}`),
    }
    const client = new Client({ appId, appSecret, appType: AppType.SelfBuild, domain, logger })
    this.client = client
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": (data) => this.onMessage(data),
    })
    // pong 看门狗 + 断线回调：SDK 默认全关（pingTimeout=0），半开连接（代理/NAT 静默断）
    // 会让 running:true 的僵尸长连接一条消息都收不到，且不留任何日志。60s 无入站即判死重建。
    // wsConfig 在 SDK 里只取 pingTimeout 一个字段，不会动 autoReconnect/pingInterval 默认值。
    const ws = new WSClient({
      appId, appSecret, domain, logger,
      wsConfig: { pingTimeout: 60 },
      onError: (e) => {
        this.status.error = String(e?.message || e)
        this.log(`飞书 WS 错误：${e?.message || e}`)
      },
      onReconnecting: () => this.log("飞书 WS 断线，自动重连中…"),
      onReconnected: () => {
        this.status.error = ""
        this.log("飞书 WS 已重连")
      },
    })
    this.ws = ws
    await ws.start({ eventDispatcher: dispatcher })
    // @ 识别要机器人自己的 open_id：启动时用凭据自动获取，省掉手配 botName/botOpenId。
    this.botOpenId = await this.resolveBotOpenId()
    this.status.running = true
    this.status.error = ""
    this.log(`飞书通道已启动：${appId}（长连接收消息，私聊 ${this.feishuCfg.allowUsers.length ? this.feishuCfg.allowUsers.length + " 人白名单" : "放行"} · 全收群 ${this.feishuCfg.groups.high.length} · 其余群 @ 响应）`)
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

  // 出站直发（Outbox feishu 渠道的 adapter）：用入站同一个 app 的 SDK client 发消息。
  // text/markdown 都按飞书 text 消息发——markdown 修饰符原样保留，换 app 转渲染不值得。
  async sendOutbound({ chatId = "", userId = "", text = "", markdown = "" } = {}) {
    if (!this.client) throw new Error("飞书通道未启动（feishu.enabled=false 或启动失败），feishu 渠道不可外发")
    const receiveId = String(chatId || userId || "").trim()
    if (!receiveId) throw new Error("feishu 渠道外发需要 chatId 或 userId（open_id）")
    const body = String(text.trim() ? text : markdown)
    const r = await this.client.im.v1.message.create({
      params: { receive_id_type: chatId ? "chat_id" : "open_id" },
      data: { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text: body }) },
    })
    if (r?.code !== 0) throw new Error(`飞书外发失败：code=${r?.code} ${r?.msg || "未知错误"}`)
    return r?.data ?? {}
  }

  // 租户凭证 → 机器人信息 → bot open_id。失败不挡启动：回落到配置里的 botName/botOpenId，
  // 什么都没有时非 high 群识别不了 @，会按拒收日志提示。
  async resolveBotOpenId() {
  const { appId, appSecret, domain } = this.feishuCfg
  const open = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"
  try {
    const tokResp = await fetch(`${open}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const tok = await tokResp.json()
    if (!tok.tenant_access_token) throw new Error(tok.msg || `HTTP ${tokResp.status}`)
    const botResp = await fetch(`${open}/open-apis/bot/v3/info`, {
      headers: { authorization: `Bearer ${tok.tenant_access_token}` },
    })
    const bot = await botResp.json()
    const openId = botOpenIdFromInfo(bot)
    if (!openId) throw new Error(bot?.msg || "bot info 缺 open_id")
    this.log(`飞书机器人身份就绪：${openId}（群聊 @ 识别用）`)
    return openId
  } catch (e) {
    this.log(`拿机器人 open_id 失败（群聊 @ 识别回落到配置 botName/botOpenId）：${e.message}`)
    return this.feishuCfg.botOpenId || ""
  }
}

  async onMessage(data) {
    try {
      const verdict = classifyInbound(this.feishuCfg, data, {
        botOpenId: this.botOpenId || this.feishuCfg.botOpenId,
        botName: this.feishuCfg.botName,
      })
      this.status.lastInboundAt = nowIso()
      if (!verdict.accept) {
        this.status.rejected++
        // 私聊被白名单拒收时把 sender 带出来：用户照抄进 config.json 的 allowUsers 就能放行。
        const senderHint = verdict.senderId ? `，sender=${verdict.senderId}` : ""
        this.log(`飞书消息不收：${verdict.reason}${senderHint}（${verdict.messageId || "无 id"}）`)
        // 真实推流的事件体可能和文档不一致（content 缺失/脱敏/形状变化）：拒收时 dump 原始事件，照日志对账。
        this.log(`飞书原始事件：${JSON.stringify(data ?? {}).slice(0, 2000)}`)
        return
      }
      if (!this.dedup.check(verdict.messageId)) {
        this.status.duplicates++
        return
      }
      this.status.accepted++
      // 诊断留痕：最近一次回复目标 + 入站时间。回复发到哪由 router agent 看来源说明后
      // 自己调 foreman send 入 Outbox（deliver 包装带 chatId 与建议命令），这里不再记账本环。
      const clientId = `feishu-${verdict.messageId}`.slice(0, 128)
      const book = new Book(this.cfg.stateFile)
      book.reload()
      const st = feishuState(book)
      st.replyTarget = verdict.chatType === "p2p"
        ? { kind: "user", id: verdict.senderId, chatId: verdict.chatId }
        : { kind: "chat", id: verdict.chatId }
      st.lastInboundAt = nowIso()
      book.save()
      // client 格式与 chat.send 的 cleanClientId 兼容（字母数字._:-），复用同一套去重与 UI 口径。
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
