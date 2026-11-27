// 飞书通道：入站分类（白名单/群分级/@识别）、message_id 去重、Gateway 入箱、
// 回复推送泵的增量锚定，以及 feishu 配置归一。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classifyInbound, MessageDedup, FeishuGateway, botOpenIdFromInfo } from "../src/feishu.mjs"
import { loadConfig, normalizeFeishuSection } from "../src/config.mjs"
import { startServer } from "../src/service.mjs"

const feishuCfg = (over = {}) => ({
  enabled: true,
  appId: "cli_a",
  appSecret: "s",
  domain: "feishu",
  allowUsers: ["ou_boss"],
  groups: { high: ["oc_high"] },
  botName: "foreman-bot",
  botOpenId: "ou_bot",
  replyPollSeconds: 5,
  ...over,
})

const evt = (over = {}) => {
  // 顶层只认 sender，其余覆盖都落进 message（chat_type/message_id/mentions/body…）。
  const { sender, ...msg } = over
  return {
    sender: sender ?? { sender_id: { open_id: "ou_boss", user_id: "u1", union_id: "un1" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_high",
      chat_type: "group",
      message_type: "text",
      mentions: [],
      body: { content: JSON.stringify({ text: "帮我看看这个工单" }) },
      ...msg,
    },
  }
}

test("classifyInbound：私聊白名单放行并替换 @占位符；不在名单拒收", () => {
  const cfg = feishuCfg()
  const p2p = evt({
    chat_type: "p2p",
    chat_id: "oc_dm",
    mentions: [{ key: "@_user_1", name: "foreman-bot" }],
    body: { content: JSON.stringify({ text: "@_user_1 这个 PR 什么状态" }) },
  })
  const ok = classifyInbound(cfg, p2p, { botName: "foreman-bot" })
  assert.deepEqual(
    { ...ok, text: ok.text },
    { accept: true, chatType: "p2p", chatId: "oc_dm", senderId: "ou_boss", messageId: "om_1", text: "@foreman-bot 这个 PR 什么状态" }
  )
  const stranger = evt({ chat_type: "p2p", sender: { sender_id: { open_id: "ou_other" } } })
  const no = classifyInbound(cfg, stranger)
  assert.equal(no.accept, false)
  assert.match(no.reason, /白名单/)
})

test("classifyInbound：WS 长连接事件形状（content 直接挂 message 上，无 body 壳）也能读出正文", () => {
  // 2026-11-26 真机 dump：WS 推送解包后 message.content 直接是正文 JSON，与 webhook 文档的 body.content 不同。
  const ws = evt({
    chat_type: "p2p",
    chat_id: "oc_dm",
    content: JSON.stringify({ text: "测试" }),
    body: undefined,
  })
  const ok = classifyInbound(feishuCfg(), ws)
  assert.equal(ok.accept, true)
  assert.equal(ok.text, "测试")
})

test("botOpenIdFromInfo：真实响应 open_id 在顶层 bot 下，不在 data 下", () => {
  // 2026-11-26 实测：/bot/v3/info 成功时 msg="ok"，open_id 在顶层 bot 字段——此前读 data.open_id 每次都失败。
  const real = { code: 0, msg: "ok", bot: { activate_status: 2, app_name: "foreman-bot", open_id: "ou_real1" } }
  assert.equal(botOpenIdFromInfo(real), "ou_real1")
  assert.equal(botOpenIdFromInfo({ code: 0, msg: "ok", data: { open_id: "ou_legacy" } }), "ou_legacy")
  assert.equal(botOpenIdFromInfo({ code: 0, msg: "ok" }), "")
})

test("classifyInbound：群聊默认 @ 响应，groups.high 全收；allowUsers 留空私聊放行", () => {
  const cfg = feishuCfg()
  // 高优群：任何人发都收
  const high = evt({ sender: { sender_id: { open_id: "ou_random" } } })
  assert.equal(classifyInbound(cfg, high).accept, true)
  // 普通群：@机器人（botName 命中）才收
  const at = evt({
    chat_id: "oc_random_group",
    mentions: [{ key: "@_user_1", name: "foreman-bot", id: { open_id: "ou_bot" } }],
    body: { content: JSON.stringify({ text: "@_user_1 发布了吗" }) },
  })
  const atOk = classifyInbound(cfg, at, { botName: "foreman-bot" })
  assert.equal(atOk.accept, true)
  assert.equal(atOk.text, "@foreman-bot 发布了吗")
  // 普通群：@ 的是别人（botOpenId 不命中）
  const atOther = evt({
    chat_id: "oc_random_group",
    mentions: [{ key: "@_user_1", name: "张三", id: { open_id: "ou_zhang" } }],
    body: { content: JSON.stringify({ text: "@_user_1 你看一下" }) },
  })
  const no = classifyInbound(cfg, atOther, { botOpenId: "ou_bot" })
  assert.equal(no.accept, false)
  assert.match(no.reason, /@机器人/)
  // 普通群：没 @ 任何人
  assert.equal(classifyInbound(cfg, evt({ chat_id: "oc_random_group" }), { botName: "foreman-bot" }).accept, false)

  // 私聊白名单留空 = 放行所有私聊
  const openCfg = feishuCfg({ allowUsers: [] })
  const anyone = classifyInbound(openCfg, evt({ chat_type: "p2p", chat_id: "oc_dm", sender: { sender_id: { open_id: "ou_stranger" } } }))
  assert.equal(anyone.accept, true)
  // 配了白名单：名单外拒收
  const stranger = classifyInbound(cfg, evt({ chat_type: "p2p", chat_id: "oc_dm", sender: { sender_id: { open_id: "ou_other" } } }))
  assert.equal(stranger.accept, false)
  assert.match(stranger.reason, /白名单/)
})

test("classifyInbound：非文本与缺 id 拒收", () => {
  const cfg = feishuCfg()
  const image = evt({ message_type: "image", body: { content: JSON.stringify({ image_key: "img_1" }) } })
  assert.equal(classifyInbound(cfg, image).accept, false)
  const noId = evt({ message_id: "" })
  assert.equal(classifyInbound(cfg, noId).accept, false)
})

test("MessageDedup：首见放行、TTL 内拦截、过期放行", async () => {
  const dedup = new MessageDedup({ ttlMs: 5 })
  assert.equal(dedup.check("om_a"), true)
  assert.equal(dedup.check("om_a"), false)
  assert.equal(dedup.check("om_b"), true)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(dedup.check("om_a"), true)
})

function tmpCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-feishu-"))
  const stateFile = path.join(dir, "state.json")
  return { dir, stateFile }
}

// 直接改账本里的飞书状态（模拟 Gateway 已收到过消息 / 服务上次的推送断点）。
const setFeishuState = (stateFile, patch) => {
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  } catch {}
  data.feishu = { ...(data.feishu ?? {}), ...patch }
  fs.writeFileSync(stateFile, JSON.stringify(data))
}

test("FeishuGateway.onMessage：命中入箱（payload/dedupeKey/replyTarget）、重复与拒收计数", async () => {
  const { stateFile } = tmpCtx()
  const enqueued = []
  const logs = []
  const gateway = new FeishuGateway({
    cfg: { stateFile, feishu: feishuCfg() },
    ctx: { inbox: { enqueue: (e) => enqueued.push(e) } },
    log: (m) => logs.push(m),
  })
  await gateway.onMessage(evt({ chat_type: "p2p", chat_id: "oc_dm" }))
  assert.equal(enqueued.length, 1)
  const event = enqueued[0]
  assert.equal(event.kind, "chat.message")
  assert.equal(event.text, "帮我看看这个工单")
  assert.equal(event.payload.source, "feishu")
  assert.equal(event.payload.chatType, "p2p")
  assert.equal(event.payload.senderId, "ou_boss")
  assert.equal(event.dedupeKey, `chat:message:${event.payload.clientId}`)
  assert.match(event.payload.clientId, /^feishu-om_1$/)
  // 回复目标跟来源走：私聊 → user（带会话 id，回复优先发 chat_id）
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8")).feishu
  assert.deepEqual(st.replyTarget, { kind: "user", id: "ou_boss", chatId: "oc_dm" })

  // WS 重连重投同一 message_id：不重复入箱，计入 duplicates
  await gateway.onMessage(evt({ chat_type: "p2p", chat_id: "oc_dm" }))
  assert.equal(enqueued.length, 1)
  assert.equal(gateway.status.duplicates, 1)

  // 白名单外拒收：不入箱，计入 rejected 并落日志
  await gateway.onMessage(evt({ chat_type: "p2p", sender: { sender_id: { open_id: "ou_no" } } }))
  assert.equal(enqueued.length, 1)
  assert.equal(gateway.status.rejected, 1)
  assert.equal(gateway.status.accepted, 1)
  assert.ok(logs.some((m) => m.includes("白名单")))
  assert.equal(gateway.status.lastInboundAt !== "", true)

  // 群聊来源：回复目标切到 chat（诊断留痕）
  await gateway.onMessage(evt({ message_id: "om_2" }))
  const st2 = JSON.parse(fs.readFileSync(stateFile, "utf8")).feishu
  assert.deepEqual(st2.replyTarget, { kind: "chat", id: "oc_high" })
})

test("FeishuGateway.onMessage：机器人自己的消息按回声拒收（防直发循环）", async () => {
  const { stateFile } = tmpCtx()
  const enqueued = []
  const logs = []
  const gateway = new FeishuGateway({
    // botOpenId 已就绪（启动时 resolveBotOpenId 拿到的身份）
    cfg: { stateFile, feishu: feishuCfg({ botOpenId: "ou_self_bot" }) },
    ctx: { inbox: { enqueue: (e) => enqueued.push(e) } },
    log: (m) => logs.push(m),
  })
  // p2p 回声：agent 直发的回复原样回来（sender = bot 自己），私聊白名单为空本会放行
  await gateway.onMessage(evt({ chat_type: "p2p", chat_id: "oc_dm", message_id: "om_echo1", sender: { sender_id: { open_id: "ou_self_bot" } } }))
  assert.equal(enqueued.length, 0)
  assert.equal(gateway.status.rejected, 1)
  assert.ok(logs.some((m) => m.includes("回声")))
  // 群聊回声：机器人自己在群里发的消息（即使带 @ 自己的占位也不收）
  await gateway.onMessage(evt({ message_id: "om_echo2", sender: { sender_id: { open_id: "ou_self_bot" } }, mentions: [{ key: "@_user_1", name: "bot", id: { open_id: "ou_self_bot" } }] }))
  assert.equal(enqueued.length, 0)
  assert.equal(gateway.status.rejected, 2)
})


test("FeishuGateway：worker 认领点亮处理中，回复送出/投递失败熄灭，view 透出", () => {
  const { stateFile } = tmpCtx()
  const gateway = new FeishuGateway({
    cfg: { stateFile, feishu: feishuCfg() },
    ctx: { inbox: { enqueue: () => {} } },
    log: () => {},
  })
  assert.equal(gateway.status.processing, null)

  // worker 认领到一批 chat.message（含控制台来源的）：只按飞书来源点亮，取最后一条
  gateway.markProcessing([
    { text: "控制台问的", payload: { source: "chat-ui", clientId: "c1" } },
    { text: "帮我查一下线上问题，比较急，麻烦看下", payload: { source: "feishu", chatType: "p2p", chatId: "oc_dm", senderId: "ou_boss", clientId: "feishu-om_9" } },
  ])
  assert.deepEqual(
    { ...gateway.status.processing, since: "" },
    { chatId: "oc_dm", chatType: "p2p", senderId: "ou_boss", text: "帮我查一下线上问题，比较急，麻烦看下", since: "" }
  )
  // view() 透出给 /api/feishu 与控制台
  assert.equal(gateway.view().processing.chatId, "oc_dm")

  // bot 回复经 outbox 送出 → Dispatcher 调 clearProcessing 熄灭
  gateway.clearProcessing()
  assert.equal(gateway.status.processing, null)
  assert.equal(gateway.view().processing, null)

  // 非飞书批次不点亮
  gateway.markProcessing([{ text: "x", payload: { source: "chat-ui" } }])
  assert.equal(gateway.status.processing, null)
})

test("feishu 配置归一：默认关闭不要求凭据；开启缺凭据/入口/@识别直接报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-feishu-cfg-"))
  const write = (obj) => {
    const file = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, JSON.stringify(obj))
    return loadConfig(file)
  }
  // 默认关闭：不填凭据也能过，且字段归一成默认值
  const off = write({})
  assert.equal(off.feishu.enabled, false)
  assert.deepEqual(off.feishu.groups, { high: [] })
  assert.equal(off.feishu.replyPollSeconds, 5)
  // 开了没凭据
  assert.throws(() => write({ feishu: { enabled: true } }), /appId\/appSecret 必填/)
  // 名单归一：空串剔除（非字符串原样转字符串保留）；合法开启配置正常归一
  const on = write({
    feishu: { enabled: true, appId: "cli_a", appSecret: "s", allowUsers: ["ou_a", "", "   "], groups: { high: ["oc_h"], low: ["oc_l"] }, botName: "bot" },
  }).feishu
  assert.deepEqual(on.allowUsers, ["ou_a"])
  assert.deepEqual(on.groups, { high: ["oc_h"] })
  assert.throws(() => write({ feishu: { enabled: true, appId: "a", appSecret: "s", allowUsers: ["ou_a"], replyPollSeconds: 0 } }), /replyPollSeconds/)
  // domain 只认 feishu|lark
  assert.throws(() => write({ feishu: { enabled: true, appId: "a", appSecret: "s", allowUsers: ["ou_a"], domain: "slack" } }), /feishu\|lark/)
})

// ---- 控制台配置面板支撑：normalizeFeishuSection / applyFeishu / 设备授权 ----

test("normalizeFeishuSection：归一不改入参对象、enabled 校验口径与 loadConfig 一致", () => {
  // 整段替换语义（合并发生在 applyFeishu 层）：groups 原样归一，没传 low 就是空
  const merged = normalizeFeishuSection({
    ...feishuCfg(),
    groups: { high: ["oc_new"] },
  })
  assert.equal(merged.appId, "cli_a")
  assert.deepEqual(merged.allowUsers, ["ou_boss"])
  assert.deepEqual(merged.groups, { high: ["oc_new"] })
  // 非对象兜底 + 空 groups 兜底；旧 groups.low 读入即忽略
  assert.deepEqual(normalizeFeishuSection(null).groups, { high: [] })
  assert.equal(normalizeFeishuSection("x").enabled, false)
  assert.throws(() => normalizeFeishuSection({ enabled: true }), /appId\/appSecret 必填/)
  assert.deepEqual(normalizeFeishuSection({ groups: { high: ["oc_h"], low: ["oc_l"] } }).groups, { high: ["oc_h"] })
})

function startServerCfg(obj = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-feishu-srv-"))
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify({
    stateFile: path.join(dir, "state.json"),
    agent: "noop",
    feishu: { enabled: false },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    ...obj,
  }))
  return { cfg: loadConfig(file), dir, file }
}

test("applyFeishu：保存写回 config.json + 通道热启停（enabled 开关当场生效）", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg, dir } = startServerCfg()
  const server = await startServer({ cfg, book: null, driver: { runningMap: async () => ({}) }, log: () => {} })
  try {
    // 默认关闭：view 里 enabled=false、无 gateway
    assert.equal(server.ctx.feishu, null)

    // 保存开启（appId 故意不合 SDK 规则以避免真连网；归一只要求非空）：
    // 写回 config.json、gateway 拉起、auth 器常驻；低优群 + botName 一并给上（后面验证不被界面 patch 冲掉）
    const view = await server.ctx.applyFeishu({ enabled: true, appId: "cli_bad", appSecret: "s", groups: { high: ["oc_h"] } })
    assert.equal(view.ok, true)
    assert.equal(view.config.enabled, true)
    assert.deepEqual(view.config.groups.high, ["oc_h"])
    const onDisk = JSON.parse(fs.readFileSync(cfg.configFile, "utf8"))
    assert.equal(onDisk.feishu.enabled, true)
    assert.equal(onDisk.feishu.appId, "cli_bad")
    assert.ok(server.ctx.feishu, "保存开启后通道要拉起")
    assert.equal(server.ctx.feishu.view().running, true)

    // merge 语义：界面只 patch groups.high，appId/低优群/botName 不动
    const view2 = await server.ctx.applyFeishu({ groups: { high: ["oc_h2"] } })
    assert.equal(view2.config.appId, "cli_bad")
    assert.deepEqual(view2.config.groups.high, ["oc_h2"])
        
    // 新口径：只有凭据就能开启（私聊放行 + 群 @ 响应），不再要求入口名单
    const view4 = await server.ctx.applyFeishu({ groups: { high: [] }, allowUsers: [] })
    assert.equal(view4.config.enabled, true)
    await server.ctx.applyFeishu({ groups: { high: ["oc_h"] }, allowUsers: [] })

    // 关闭：通道停掉，config.json 同步
    const view3 = await server.ctx.applyFeishu({ enabled: false })
    assert.equal(view3.gateway, null)
    assert.equal(JSON.parse(fs.readFileSync(cfg.configFile, "utf8")).feishu.enabled, false)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("/api/feishu：GET 读配置与状态，POST 保存/校验失败返回 400", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg, dir } = startServerCfg()
  const server = await startServer({ cfg, book: null, driver: { runningMap: async () => ({}) }, log: () => {} })
  try {
    const get1 = await (await fetch(`http://127.0.0.1:${server.port}/api/feishu`)).json()
    assert.equal(get1.ok, true)
    assert.equal(get1.config.enabled, false)
    assert.equal(get1.auth, undefined, "设备授权已移除，不应再有 auth 字段")

    const bad = await fetch(`http://127.0.0.1:${server.port}/api/feishu`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { enabled: true, appId: "cli_bad", appSecret: "", groups: { high: [] } } }),
    })
    assert.equal(bad.status, 400)

    const post = await fetch(`http://127.0.0.1:${server.port}/api/feishu`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { enabled: true, appId: "cli_bad", appSecret: "s", groups: { high: ["oc_h"] } } }),
    })
    const saved = await post.json()
    assert.equal(saved.ok, true)
    assert.equal(saved.config.enabled, true)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("FeishuGateway.start：无凭据明确报错，不进 SDK 也不触网", async () => {
  const gw = new FeishuGateway({ cfg: { feishu: feishuCfg({ appId: "", appSecret: "" }) }, ctx: {}, log: () => {} })
  await assert.rejects(() => gw.start(), /凭据未配置/)
})

test("FeishuGateway.sendOutbound：同 app 直发，chat_id/open_id 二选一，code!=0 报错", async () => {
  const calls = []
  const gw = new FeishuGateway({ cfg: { feishu: feishuCfg() }, ctx: {}, log: () => {} })
  gw.client = {
    im: { v1: { message: {
      create: async ({ params, data }) => {
        calls.push({ params, data })
        return { code: 0, msg: "success", data: { message_id: "om_out" } }
      },
    } } },
  }
  const okResp = await gw.sendOutbound({ chatId: "oc_dm", markdown: "**hi**" })
  assert.equal(okResp.message_id, "om_out")
  assert.deepEqual(calls[0].params, { receive_id_type: "chat_id" })
  assert.deepEqual(calls[0].data, { receive_id: "oc_dm", msg_type: "text", content: JSON.stringify({ text: "**hi**" }) })

  // 无 chatId 时按 open_id 发（出站与入站同 app，不会跨 app）
  await gw.sendOutbound({ userId: "ou_boss", text: "hello" })
  assert.deepEqual(calls[1].params, { receive_id_type: "open_id" })

  // 业务错误码透出
  gw.client.im.v1.message.create = async () => ({ code: 99992361, msg: "open_id cross app" })
  await assert.rejects(() => gw.sendOutbound({ chatId: "oc_x", text: "y" }), /99992361.*cross app/s)

  // 通道没起：明确报错
  const off = new FeishuGateway({ cfg: { feishu: feishuCfg() }, ctx: {}, log: () => {} })
  await assert.rejects(() => off.sendOutbound({ chatId: "oc_x", text: "y" }), /未启动/)
})
