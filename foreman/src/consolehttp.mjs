// 控制台 HTTP：由常驻服务直接对外提供页面与 API，不另起进程、不走 socket。
//   GET  /                 控制台页面（Vite 构建产物 console/dist）
//   GET  /assets/<name>    带 hash 的 js/css，长缓存
//   GET  /api/snapshot?day=YYYY-MM-DD  当天（或指定某天）任务 + PR + 统计；看今天时先跟账本对齐
//   GET  /api/inbox?page=1&pageSize=20&status=   持久 Inbox 事件、分页总数与状态统计（只读）
//   GET  /api/outbox?page=1&pageSize=20&status=&channel=  持久 Outbox 消息、分页总数与状态统计（只读）
//   GET  /api/polls        最近几轮扫描记录
//   GET  /api/history?days=7&day=YYYY-MM-DD&repo=R&key=<owner>/<repo>#<N>  历史事件（按天分组）
//   POST /api/sync         立刻扫一轮 PR（Gitea REST）+ 落库，返回最新快照
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { Book } from "./book.mjs"
import { sessionTasks } from "./tasktree.mjs"
import { createChatStreamSource } from "./chatstream.mjs"

const MAX_BODY = 1 << 20
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const TOKEN_COOKIE = "foreman_token"

export const isLoopbackAddress = (addr) => LOOPBACK_ADDRESSES.has(String(addr ?? "").trim())

function cookieToken(cookieHeader) {
  const hit = String(cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${TOKEN_COOKIE}=`))
  return hit ? hit.slice(TOKEN_COOKIE.length + 1) : ""
}

function tokenEquals(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8")
  const right = Buffer.from(String(b ?? ""), "utf8")
  if (!left.length || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/**
 * 绑定到非回环地址时的访问控制：回环请求（本机 CLI / 页面）免验，
 * 其余来源必须带 cookie、`x-foreman-token` 头或 `?token=` 之一。
 * 返回 { ok, setCookie }；没配 token 视为不设防（老行为）。
 */
export function checkConsoleToken({ token, remoteAddress, cookieHeader = "", headerToken = "", queryToken = "" } = {}) {
  if (!token) return { ok: true, setCookie: false }
  if (isLoopbackAddress(remoteAddress)) return { ok: true, setCookie: false }
  const cookie = cookieToken(cookieHeader)
  if (tokenEquals(headerToken, token) || tokenEquals(cookie, token)) return { ok: true, setCookie: false }
  if (tokenEquals(queryToken, token)) return { ok: true, setCookie: true }
  return { ok: false, setCookie: false }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

const sendJson = (res, code, body) => {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

function serveStatic(res, dir, name, { immutable = false, noStore = false } = {}) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("not found")
  }
  const buf = fs.readFileSync(file)
  const cacheControl = noStore ? "no-store" : immutable ? "public, max-age=31536000, immutable" : "no-cache"
  res.writeHead(200, {
    "content-type": MIME[path.extname(name)] || "application/octet-stream",
    "cache-control": cacheControl,
  })
  res.end(buf)
}

// 前端还没构建时的兜底页：说清楚该跑什么命令，别只回 404。
function serveBuildHint(res) {
  const text = `<!doctype html><meta charset="utf-8"><title>foreman 控制台未构建</title>
<style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0b0f14;color:#cbd5e1;padding:48px}
pre{background:#111826;padding:12px 16px;border-radius:8px;color:#7dd3fc}</style>
<h2>控制台前端还没有构建</h2>
<p>在 foreman 目录跑一次构建，产物会落到 <code>console/dist</code>，服务直接从本地下发：</p>
<pre>cd ~/Documents/workspace/doubao-bot/foreman &amp;&amp; npm run build:console</pre>
<p>开发时可以用 <code>npm run dev:console</code>（Vite dev server，走 /api 代理到 7317）。</p>`
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(text)
}

/**
 * 起 HTTP 监听（同时承担 CLI 的 RPC 通道与控制台页面）。
 * port 传 0 由系统分配；被占用时抛 code=EADDRINUSE，交给调用方处理。
 * onRpc：CLI 请求分发（service.mjs 的 handleRequest）。
 */
export function startConsoleHttp({ store, ctx, dir, host, port, token = "", log = () => {}, onRpc = null }) {
  const startedAt = Date.now()
  // Chat 实时流：zcode 只读库的增量转录（src/chatstream.mjs）。并发流上限防多开页面积拖垮 sqlite3。
  const chatStream = createChatStreamSource({ ctx, log })
  let chatStreamClients = 0
  const CHAT_STREAM_MAX = 4
  const CHAT_STREAM_TICK_MS = 1000
  const CHAT_STREAM_HEARTBEAT_MS = 15000

  // SSE 常驻推流：snapshot（全量）→ 每秒 delta（增量行）/ status（运行态翻转），15s 心跳。
  // 断线由 EventSource 自动重连，重连后服务端重发 snapshot，客户端整树重建——无需断点续传。
  const startChatStream = (res, req, url) => {
    const convParam = (url.searchParams.get("conv") || "").trim()
    chatStreamClients += 1
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {}
    }
    let timer = null
    let heartbeat = null
    let closed = false
    let cursor = 0
    let conv = convParam
    let running = null
    let lastErrorAt = 0
    const cleanup = () => {
      if (closed) return
      closed = true
      if (timer) clearInterval(timer)
      if (heartbeat) clearInterval(heartbeat)
      chatStreamClients -= 1
      try {
        res.end()
      } catch {}
    }
    req.on("close", cleanup)
    res.on("error", cleanup)
    // res.on("error") 覆盖不到底层 socket：客户端强断时 socket 的 EPIPE 无人接会炸进程。
    res.socket?.on?.("error", () => {})
    const pulse = async () => {
      if (closed) return
      try {
        const d = await chatStream.transcript(conv, cursor)
        if (d.conv) conv = d.conv // 空 conv 首轮解析出的 router 会话，之后按真 id 轮询
        if (d.rows.length) {
          cursor = Math.max(cursor, Number(d.cursor) || 0)
          send("delta", d)
        }
        if (d.running !== running) {
          running = d.running
          send("status", { running: d.running })
        }
      } catch (e) {
        // 库暂时读不回（zcode 升级/锁表）：限频报错，别把客户端刷屏。
        if (Date.now() - lastErrorAt > 30000) {
          lastErrorAt = Date.now()
          send("stream-error", { message: e.message })
        }
      }
    }
    void (async () => {
      try {
        const snap = await chatStream.transcript(convParam, 0)
        conv = snap.conv || convParam
        cursor = Number(snap.cursor) || 0
        send("snapshot", snap)
        send("sessions", await chatStream.sessions())
      } catch (e) {
        send("stream-error", { message: e.message })
      }
      timer = setInterval(pulse, CHAT_STREAM_TICK_MS)
      heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n")
        } catch {}
      }, CHAT_STREAM_HEARTBEAT_MS)
      await pulse()
    })()
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let buf = ""
      req.on("data", (d) => {
        buf += d
        if (buf.length > MAX_BODY) {
          reject(Object.assign(new Error("请求体过大"), { code: "too_large" }))
          req.destroy()
        }
      })
      req.on("end", () => {
        if (!buf.trim()) return resolve({})
        try {
          resolve(JSON.parse(buf))
        } catch (e) {
          reject(Object.assign(e, { code: "bad_json" }))
        }
      })
      req.on("error", reject)
    })

  const snapshotNow = async (day = "") => {
    const book = new Book(ctx.cfg.stateFile)
    // 首页「进行中」按执行会话的真实 running 状态算，不把待收口的 working 账本行算进去。
    // 历史某天仍展示当日状态；读不到侧边栏时退回原账本口径，避免把暂时不可用误报成 0。
    let runningSessions = null
    if (!day && typeof ctx.session?.runningMap === "function") {
      try {
        runningSessions = await ctx.session.runningMap()
      } catch (e) {
        log(`控制台读实时会话状态失败，进行中暂按账本统计：${e.message}`)
      }
    }
    // 回看历史某天不用再扫一遍账本写库；看今天才同步，保持实时。
    const sync = day ? null : store.sync(book)
    const snapshot = store.snapshot({
      book,
      cfg: ctx.cfg,
      pr: { ...ctx.state.pr, lastNewPrs: sync?.newPrs ?? 0 },
      service: {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        socket: ctx.cfg.service?.socket ?? "",
        http: ctx.httpUrl ?? "",
      },
      day,
      runningSessions,
    })
    if (day) return snapshot
    // 当前任务页与 CLI 共用同一份会话树；历史日期仍按事件回放展示旧工单视图。
    // 复用上面已读的侧边栏，避免一次快照触发两次载体查询。
    const tree = await sessionTasks({
      cfg: ctx.cfg,
      session: {
        runningMap: async () => {
          if (runningSessions === null) throw new Error("载体侧边栏状态不可用")
          return runningSessions
        },
      },
    })
    return {
      ...snapshot,
      sessions: tree.sessions,
      summary: tree.summary,
      sessionStatus: { source: tree.statusSource, error: tree.statusError },
      stats: {
        ...snapshot.stats,
        tasks: tree.summary.sessions,
        working: tree.summary.runningWorkers,
        prOpen: tree.summary.prOpenIssues,
        unresolved: tree.summary.unresolvedIssues,
        taskLabel: "当前分配会话",
        workingLabel: "真实运行",
      },
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`)
    const pathname = decodeURIComponent(url.pathname)

    // 监听 0.0.0.0 时，非本机来源先过 token，避免局域网/Tailnet 里谁都能点合并、派活。
    if (token) {
      const verdict = checkConsoleToken({
        token,
        remoteAddress: req.socket?.remoteAddress,
        cookieHeader: req.headers.cookie,
        headerToken: req.headers["x-foreman-token"],
        queryToken: url.searchParams.get("token") ?? "",
      })
      if (!verdict.ok) {
        if (pathname.startsWith("/api/")) return sendJson(res, 401, { ok: false, error: "auth_required", message: "访问地址带上 ?token=，或用 x-foreman-token 头" })
        const text = "<!doctype html><meta charset=\"utf-8\"><title>foreman 控制台需要 token</title><p>这个地址不是本机访问，请用带 token 的链接打开（token 在服务端的 console.token 文件里）。"
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(text)
      }
      if (verdict.setCookie) {
        res.setHeader("set-cookie", `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`)
      }
    }

    try {
      if (pathname === "/api/ping") {
        const r = onRpc ? await onRpc({ id: "ping", cmd: "ping" }) : { ok: true, pid: process.pid }
        return sendJson(res, 200, r)
      }

      if (pathname === "/api/chat") {
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        if (req.method === "GET") {
          // conv= 指定看哪条会话（侧边栏点选）；缺省读 router 当前会话。
          const conv = (url.searchParams.get("conv") || "").trim()
          const cmd = conv ? { id: "http-chat-messages", cmd: "chat messagesFor", target: conv } : { id: "http-chat-messages", cmd: "chat messages" }
          return sendJson(res, 200, await onRpc(cmd))
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const result = await onRpc({ id: "http-chat-send", cmd: "chat send", text: body?.text, clientId: body?.clientId })
        return sendJson(res, result?.ok === false ? 400 : 202, result)
      }

      if (pathname === "/api/chat/clear" || pathname === "/api/chat/archive") {
        // /clear 新建 Router 会话（轮换）；归档账本会话（Router 当前会话服务端拒绝）。都走 RPC。
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const cmd = pathname === "/api/chat/clear" ? "chat clear" : "chat archive"
        const result = await onRpc({ id: `http-${cmd}`, cmd, target: body?.conv })
        return sendJson(res, result?.ok === false ? 400 : 200, result)
      }

      if (pathname === "/api/chat/sessions" || pathname === "/api/chat/transcript" || pathname === "/api/chat/stream") {
        // Chat 实时流三件套：会话树（含 CreateSession 子会话）/ 一次性增量 / SSE 常驻推流。
        // zcode 载体专属；非 zcode 载体返回空 nodes，前端回退老的账本视图。
        if (pathname === "/api/chat/stream") {
          if (chatStreamClients >= CHAT_STREAM_MAX) {
            return sendJson(res, 429, { ok: false, error: "too_many_streams", message: `实时流并发已满（${CHAT_STREAM_MAX}），关掉多余的 Chat 页再试` })
          }
          return startChatStream(res, req, url)
        }
        try {
          if (pathname === "/api/chat/sessions") return sendJson(res, 200, await chatStream.sessions())
          if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
          const conv = (url.searchParams.get("conv") || "").trim()
          const since = Number(url.searchParams.get("since")) || 0
          return sendJson(res, 200, await chatStream.transcript(conv, since))
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.code || "chat_stream_failed", message: e.message })
        }
      }

      if (pathname === "/api/rpc") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const r = await onRpc(body)
        return sendJson(res, 200, r)
      }

      if (pathname === "/api/snapshot") {
        return sendJson(res, 200, await snapshotNow((url.searchParams.get("day") || "").trim()))
      }

      if (pathname === "/api/inbox" || pathname === "/api/outbox") {
        // 首页队列只读视图：复用服务层 inbox/outbox list，避免 HTTP 另维护一套数据口径。
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        const kind = pathname === "/api/inbox" ? "inbox" : "outbox"
        const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1))
        const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("pageSize") ?? url.searchParams.get("limit")) || 20)))
        const status = (url.searchParams.get("status") || "").trim()
        const r = await onRpc({
          id: `http-${kind}-list`,
          cmd: `${kind} list`,
          limit: pageSize,
          offset: (page - 1) * pageSize,
          status,
          ...(kind === "outbox" ? { channel: (url.searchParams.get("channel") || "").trim() } : {}),
        })
        const rows = kind === "inbox" ? r?.events : r?.messages
        const total = Math.max(0, Number(r?.total ?? rows?.length ?? 0))
        return sendJson(res, r?.ok === false ? 500 : 200, {
          ...r,
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        })
      }

      if (pathname === "/api/polls") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50)
        return sendJson(res, 200, { ok: true, polls: store.polls(limit) })
      }

      if (pathname === "/api/agent-sessions") {
        // zcode 载体的会话账本只读视图：会话跑在 herdr 窗格里，这里给统一观察窗口。
        // 账本是适配器写、这里只读——不经过服务状态，重启/换载体也不影响历史查看。
        const carrier = String(ctx.cfg?.agent ?? "").trim().toLowerCase()
        let ledgerFile = ""
        const sessions = []
        if (carrier === "zcode") {
          try {
            const { defaultLedgerPath } = await import("./zcodedrv.mjs")
            ledgerFile = String(ctx.cfg?.zcode?.ledger ?? "").trim() || defaultLedgerPath(ctx.cfg)
            const data = JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
            for (const s of Object.values(data.sessions ?? {})) {
              sessions.push({
                name: s.name,
                convId: s.convId,
                sessionId: s.sessionId || "",
                status: s.status,
                error: s.error || "",
                replyTail: String(s.lastReply ?? "").slice(-800),
                updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : "",
              })
            }
            sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
          } catch (e) {
            return sendJson(res, 200, { ok: true, carrier, ledgerFile, sessions, error: `账本读不回：${e.message}` })
          }
        }
        return sendJson(res, 200, { ok: true, carrier, ledgerFile, sessions })
      }

      if (pathname === "/api/agent") {
        // 执行载体查看/热切换：写回配置文件并当场换 session 适配器，不用重启服务。
        // agent_busy = 旧载体还有在跑的会话，前端确认后带 force 重发。
        if (req.method === "GET") {
          const info = typeof ctx.getAgent === "function" ? ctx.getAgent() : { agent: String(ctx.cfg?.agent ?? "noop"), allowed: ["noop", "dws", "zcode"] }
          return sendJson(res, 200, { ok: true, ...info })
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.setAgent !== "function") return sendJson(res, 501, { ok: false, error: "agent_set_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        try {
          const r = await ctx.setAgent(body?.agent, { force: body?.force === true })
          return sendJson(res, 200, r)
        } catch (e) {
          const status = e.code === "agent_busy" ? 409 : e.code === "bad_agent" ? 400 : 500
          return sendJson(res, status, { ok: false, error: e.code || "agent_set_failed", message: e.message })
        }
      }

      if (pathname === "/api/feishu") {
        // 飞书通道面板：GET 读配置+通道/授权状态；POST 保存 = 归一写回 config.json + 通道热重启。
        if (req.method === "GET") {
          return sendJson(res, 200, typeof ctx.feishuView === "function" ? ctx.feishuView() : { ok: true, config: ctx.cfg?.feishu ?? {}, gateway: null, auth: null })
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.applyFeishu !== "function") return sendJson(res, 501, { ok: false, error: "feishu_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        try {
          return sendJson(res, 200, await ctx.applyFeishu(body?.patch ?? {}))
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: "feishu_config_invalid", message: e.message })
        }
      }

      if (pathname === "/api/products") {
        // 项目面板：GET 读当前产品/工程；POST 保存 = 校验 → 原子写回 config.json → 热替换内存 cfg（实时生效）。
        if (req.method === "GET") {
          return sendJson(res, 200, typeof ctx.productsView === "function" ? ctx.productsView() : { ok: true, configFile: "", products: ctx.cfg?.products ?? [] })
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.applyProducts !== "function") return sendJson(res, 501, { ok: false, error: "products_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        try {
          return sendJson(res, 200, ctx.applyProducts(body ?? {}))
        } catch (e) {
          const status = e.code === "repo_busy" ? 409 : 400
          return sendJson(res, status, {
            ok: false,
            error: e.code || "products_invalid",
            message: e.message,
            // repo_busy 时带上在途明细，前端确认弹窗展示用。
            ...(e.repos ? { repos: e.repos, inflight: e.inflight } : {}),
          })
        }
      }

      if (pathname === "/api/history") {
        const days = Number(url.searchParams.get("days") ?? 7)
        return sendJson(res, 200, {
          ok: true,
          ...store.history({
            days: Number.isFinite(days) ? days : 7,
            repo: (url.searchParams.get("repo") || "").trim(),
            key: (url.searchParams.get("key") || "").trim(),
            day: (url.searchParams.get("day") || "").trim(),
          }),
        })
      }

      if (pathname === "/api/operations") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500)
        return sendJson(res, 200, {
          ok: true,
          operations: store.operations({
            limit,
            status: (url.searchParams.get("status") || "").trim(),
            action: (url.searchParams.get("action") || "").trim(),
          }),
        })
      }

      if (pathname === "/api/complete") {
        // 手动完成：只补“远端已合并、账本未收尾”，是否允许由服务层核对 PR 状态。
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const repo = String(body.repo ?? "").trim()
        const number = Number(body.number ?? 0)
        if (!repo || !number) return sendJson(res, 400, { ok: false, error: "bad-request", message: "需要 repo / number" })
        const r = await onRpc({ id: `http-${Date.now()}`, cmd: "issue complete", repo, number })
        return sendJson(res, r?.ok === false ? 409 : 200, r)
      }

      if (pathname === "/api/workflow") {
        // 首页「分配任务」用：两条 workflow 的定义、节点（含暂停状态与累计执行次数）、在跑实例。
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        if (req.method === "GET") {
          const r = await onRpc({ id: "workflow", cmd: "workflow", action: "view" })
          return sendJson(res, 200, r)
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const r = await onRpc({ id: "workflow", cmd: "workflow", action: body.action, stage: body.stage })
        return sendJson(res, r?.ok === false ? 400 : 200, r)
      }

      if (pathname === "/api/schedules") {
        const workHours = () => ctx.workHours?.() ?? {
          days: [...(ctx.cfg?.workHours?.days ?? [1, 2, 3, 4, 5])],
          start: String(ctx.cfg?.workHours?.start ?? "08:30"),
          end: String(ctx.cfg?.workHours?.end ?? "18:30"),
        }
        if (req.method === "GET") return sendJson(res, 200, { ok: true, schedules: ctx.schedules?.() ?? [], workHours: workHours() })
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.applySchedules !== "function") return sendJson(res, 501, { ok: false, error: "schedules_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const patch = body?.patch ?? body ?? {}
        try {
          const schedules = ctx.applySchedules(patch)
          return sendJson(res, 200, { ok: true, schedules, workHours: workHours() })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: "bad_patch", message: e.message })
        }
      }

      if (pathname === "/api/schedules/create") {
        // 新建 / 按 id 覆盖自定义 Agent 定时任务：写 SQLite 并重排定时器，不需要重启。
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.createSchedule !== "function") return sendJson(res, 501, { ok: false, error: "schedule_create_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const input = body?.schedule ?? body ?? {}
        try {
          const schedules = ctx.createSchedule(input)
          return sendJson(res, 200, { ok: true, schedules })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: "bad_schedule", message: e.message })
        }
      }

      if (pathname === "/api/schedules/run") {
        // 页面上点「立即执行」：不等 cron、不看开关，立刻跑一轮这类任务。
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.runSchedule !== "function") return sendJson(res, 501, { ok: false, error: "schedule_run_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const id = String(body?.id ?? "").trim()
        if (!id) return sendJson(res, 400, { ok: false, error: "missing_id", message: "没有指定要执行哪一项" })
        try {
          const r = await ctx.runSchedule(id)
          return sendJson(res, r?.ok === false ? 500 : 200, { ok: r?.ok !== false, id, result: r ?? null })
        } catch (e) {
          const code = e.code === "schedule_not_runnable" ? 400 : 500
          return sendJson(res, code, { ok: false, error: e.code || "schedule_run_failed", message: e.message })
        }
      }

      if (pathname === "/api/candidates") {
        // 首页「待分配任务」：open + 接单标签、账本里还没处理过的单。只读，不派活。
        if (typeof ctx.candidates !== "function") return sendJson(res, 501, { ok: false, error: "candidates_not_supported" })
        const r = await ctx.candidates({ refresh: url.searchParams.get("refresh") === "1" })
        return sendJson(res, 200, r)
      }

      if (pathname === "/api/pick") {
        // 手动接单：只派页面点中的那一条，不看自动接单开关。
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.pickIssue !== "function") return sendJson(res, 501, { ok: false, error: "pick_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const r = await ctx.pickIssue({ repo: body?.repo, number: body?.number })
        const conflict = new Set(["already-handled", "already-handed", "running", "node-paused", "locked"])
        return sendJson(res, r?.ok ? 200 : conflict.has(r?.error) ? 409 : 400, r)
      }

      if (pathname === "/api/pickup") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.pickup !== "function") return sendJson(res, 501, { ok: false, error: "pickup_not_supported" })
        const r = await ctx.pickup()
        return sendJson(res, 200, { ok: r?.ok !== false, pickup: r })
      }

      if (pathname === "/api/sync") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        const r = await ctx.prPoll()
        return sendJson(res, r?.ok === false ? 500 : 200, { ok: r?.ok !== false, sync: r, snapshot: await snapshotNow() })
      }

      // 控制台前端：Vite 产物（console/dist，`npm run build:console`）。
      // assets 文件名带 hash → 长缓存；页面本身不缓存。
      if (pathname === "/" || pathname === "/index.html") {
        if (!fs.existsSync(path.join(dir, "index.html"))) return serveBuildHint(res)
        return serveStatic(res, dir, "index.html", { noStore: true })
      }
      if (/^\/assets\/[A-Za-z0-9._-]+$/.test(pathname)) {
        return serveStatic(res, dir, pathname.slice(1), { immutable: true })
      }

      return sendJson(res, 404, { ok: false, error: "not_found", path: pathname })
    } catch (e) {
      log(`控制台请求失败 ${pathname}：${e.message}`)
      return sendJson(res, 500, { ok: false, error: "internal_error", message: e.message })
    }
  })

  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      server.removeAllListeners("error")
      server.on("error", (err) => log(`控制台 HTTP 异常：${err.message}`))
      reject(e)
    })
    server.listen(port, host, () => {
      server.removeAllListeners("error")
      server.on("error", (err) => log(`控制台 HTTP 异常：${err.message}`))
      const actual = server.address()?.port ?? port
      resolve({ server, port: actual, url: `http://${host}:${actual}` })
    })
  })
}
