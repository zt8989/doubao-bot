// Chat 实时流数据源：把 foreman 的账本/router 会话映射到 zcode 库里的真会话，再吐增量转录。
// consolehttp 的 /api/chat/sessions、/api/chat/transcript、/api/chat/stream 三个路由共用。
//
// 根会话来源（都是账本/Book 已有的记录，不新增状态）：
//   - zcode 载体的会话账本（ctx.dws.ledger，适配器一直在写）；
//   - Book 的 router 记录（chat workflow 老口径 book.data.router ?? inspector）。
// 账本条目首轮后才回查到真 sessionId；缺的时候就用目录+时间窗兜底（zctranscript.resolveSessionId）。
// 非 zcode 载体一切返回空——前端拿到 carrier != "zcode" 就回退老的账本视图。
import { Book } from "./book.mjs"
import { ZcTranscript, buildWatchTree } from "./zctranscript.mjs"

export function createChatStreamSource({ ctx, log = () => {} } = {}) {
  const zc = new ZcTranscript({ dbPath: ctx?.cfg?.zcode?.dbPath, log })
  // 账本 key → 真 sessionId 的解析缓存；首轮没回查到 sessionId 的条目靠目录+时间窗兜底。
  const resolved = new Map()

  const carrier = () => String(ctx?.cfg?.agent ?? "").trim().toLowerCase()

  // 账本：载体可能是裸驱动（.ledger）或适配器包装（.driver.ledger）。
  const ledgerOf = () => ctx?.dws?.ledger ?? ctx?.dws?.driver?.ledger ?? null

  // 根集合：sessionId → { name, status }（账本口径的名字/状态，展示用）。
  async function roots() {
    const roots = new Map()
    const ledger = ledgerOf()
    const put = (sessionId, name, status, updatedAt = 0) => {
      if (sessionId && !roots.has(sessionId)) roots.set(sessionId, { name: name || sessionId, status: status || "", updatedAt: updatedAt || 0 })
    }
    // router 会话优先（conv 空 = 它），Book 记录的 convId 得先过账本别名解析。
    try {
      const book = new Book(ctx.cfg.stateFile)
      const rec = book.data.router ?? book.data.inspector
      const entry = rec?.convId ? ledger?.resolve?.(rec.convId) : null
      if (entry) resolved.set(entry.key, entry.sessionId || "")
      if (entry?.sessionId) put(entry.sessionId, entry.name, entry.status, entry.updatedAt)
    } catch {}
    // 其余账本会话（router 也在账本里，重复 put 无害——先到先得，router 名字优先）。
    const sessions = ledger?.data?.sessions ?? {}
    for (const entry of Object.values(sessions)) {
      let sid = entry.sessionId || resolved.get(entry.key) || ""
      if (!sid && entry.cwd) {
        try {
          sid = (await zc.resolveSessionId({ directory: entry.cwd, sinceMs: entry.updatedAt })) || ""
        } catch {}
        resolved.set(entry.key, sid)
      }
      put(sid, entry.name, entry.status, entry.updatedAt)
    }
    return roots
  }

  // 会话树（侧栏用）：zcode 库最近会话挂到根上，带 streaming 标记。
  async function sessions() {
    const c = carrier()
    if (c !== "zcode" || !zc.available()) return { ok: true, carrier: c, nodes: [] }
    const rootMap = await roots()
    const rootIds = new Set(rootMap.keys())
    if (!rootIds.size) return { ok: true, carrier: c, nodes: [] }
    const rows = await zc.listSessions({ limit: 400 })
    const ledgerInfo = new Map([...rootMap].map(([sid, v]) => [sid, { name: v.name, status: v.status }]))
    const nodes = buildWatchTree({ rootIds, sessions: rows, ledgerInfo })
    // streaming 标记批量查；账本说 error 的以账本为准（库里的 streaming 不掩盖失败）。
    let streaming = {}
    try {
      streaming = await zc.runningFlags(nodes.map((n) => n.convId))
    } catch (e) {
      log(`chatstream streaming 标记查询失败：${e.message}`)
    }
    for (const n of nodes) {
      n.streaming = Boolean(streaming[n.convId])
      n.status = n.ledgerStatus === "error" ? "error" : n.streaming ? "running" : "done"
      n.updatedAt = n.timeUpdated ? new Date(n.timeUpdated).toISOString() : ""
      n.readOnly = !n.inLedger
      delete n.timeUpdated
    }
    return { ok: true, carrier: c, nodes }
  }

  // 解析调用方传的 conv（空 = router 当前；也兼容账本别名）。返回 { sessionId, readOnly, name }。
  async function resolveConv(conv) {
    const ledger = ledgerOf()
    const target = String(conv ?? "").trim()
    if (target) {
      const entry = ledger?.resolve?.(target)
      if (entry) {
        const sid = entry.sessionId || resolved.get(entry.key) || (await zc.resolveSessionId({ directory: entry.cwd, sinceMs: entry.updatedAt }).catch(() => ""))
        if (sid) resolved.set(entry.key, sid)
        return { sessionId: sid || target, readOnly: false, name: entry.name }
      }
      // 不是账本别名——就当 zcode 会话 id（子智能体围观路径），只读。
      return { sessionId: target, readOnly: true, name: target }
    }
    const rootMap = await roots()
    // conv 空：优先 Book 的 router 会话；没有就取最近更新的根。
    try {
      const book = new Book(ctx.cfg.stateFile)
      const rec = book.data.router ?? book.data.inspector
      const entry = rec?.convId ? ledger?.resolve?.(rec.convId) : null
      if (entry?.sessionId && rootMap.has(entry.sessionId)) return { sessionId: entry.sessionId, readOnly: false, name: entry.name }
    } catch {}
    const newest = [...rootMap.entries()]
      .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))[0]
    return newest ? { sessionId: newest[0], readOnly: false, name: newest[1].name } : { sessionId: "", readOnly: false, name: "Router Agent" }
  }

  // 增量转录：rows（message+part 混排）、running（是否在生成）、cursor（下轮 since）。
  async function transcript(conv, sinceMs = 0) {
    const c = carrier()
    if (c !== "zcode" || !zc.available()) return { ok: true, carrier: c, conv: String(conv ?? ""), rows: [], running: false, cursor: 0 }
    const { sessionId, readOnly, name } = await resolveConv(conv)
    if (!sessionId) return { ok: true, carrier: c, conv: "", rows: [], running: false, cursor: 0, name }
    // 子智能体等非账本会话：名字用库里的 title，别拿裸 id 当标题。
    const title = (await zc.sessionTitle(sessionId).catch(() => "")) || name
    const since = Number.isFinite(Number(sinceMs)) ? Math.max(0, Math.floor(Number(sinceMs))) : 0
    const { messages, parts, cursor } = await zc.tail(sessionId, { sinceMs: since })
    let running = false
    try {
      const last = await zc.lastMessage(sessionId)
      running = Boolean(last && last.role === "assistant" && !Number(last.completed ?? 0))
    } catch {}
    const rows = [...messages, ...parts]
    return { ok: true, carrier: c, conv: sessionId, name: title, readOnly, rows, running, cursor }
  }

  return { carrier, sessions, transcript, zc }
}
