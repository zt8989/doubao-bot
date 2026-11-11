// 常驻服务：unix socket 行式 JSON；按 pollSeconds 轮询 dws status，跑完才异步通知。
// 写账本一律 new Book(cfg.stateFile) 现读现写，不长期持有（run 也在写同一个 state.json）。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import crypto from "node:crypto"
import { nowIso, sleep } from "./util.mjs"
import { Book } from "./book.mjs"
import { parseResult } from "./prompts.mjs"
import { notifyTarget, shouldNotify, notifyText } from "./orchestrator.mjs"
import { prWatchOnce, prWatchTarget } from "./prwatch.mjs"
import { listPulls } from "./gitea.mjs"

export const MAX_FRAME_BYTES = 1 << 20

// ---- 帧编解码 ----

export function encodeFrame(obj) {
  return JSON.stringify(obj) + "\n"
}

// decodeFrame：空行/非法 JSON 抛错，message 里带截断原文便于排障。
export function decodeFrame(line) {
  const s = String(line ?? "")
  if (!s.trim()) {
    const e = new Error(`空帧：${JSON.stringify(s.slice(-200))}`)
    e.code = "empty"
    throw e
  }
  try {
    return JSON.parse(s)
  } catch (e) {
    const err = new Error(`坏 JSON：${e.message} :: ${s.slice(-200)}`)
    err.code = "bad_json"
    throw err
  }
}

// ---- 监听判定（纯函数）----

// 指纹：chars|head|tail 的 sha1 前 12 位；缺字段按空串。
export function fingerprintOf(status = {}) {
  const chars = String(status?.chars ?? "")
  const head = String(status?.head ?? "")
  const tail = String(status?.tail ?? "")
  return crypto.createHash("sha1").update(`${chars}|${head}|${tail}`).digest("hex").slice(0, 12)
}

// phaseOf：streaming 真=running；finished 真=finished；都假但有字有 status 串=settled；其余（含还没开始）=pending。
export function phaseOf(status) {
  if (!status || typeof status !== "object") return "unknown"
  if (status.streaming) return "running"
  if (status.finished) return "finished"
  const chars = Number(status.chars ?? 0)
  const st = String(status.status ?? "")
  if (chars > 0 && st) return "settled"
  return "pending"
}

// judgePoll：跑完 + 指纹相对上次已通知指纹变化，才发通知。
export function judgePoll(prev, status) {
  const phase = phaseOf(status)
  const fingerprint = status && Object.keys(status).length ? fingerprintOf(status) : ""
  const prevFp = prev?.fingerprint ?? ""
  const shouldNotify =
    (phase === "finished" || phase === "settled") &&
    fingerprint !== "" &&
    fingerprint !== prevFp
  return { phase, fingerprint, shouldNotify }
}

// ---- 监听对象集合 ----

// book.watch 显式条目 ∪ sessions 里 convId 非空且 notify !== false 的条目；target 去重，显式优先。
export function watchersFor(book, _cfg) {
  const map = new Map()
  for (const w of book?.watch ?? []) {
    if (!w?.target) continue
    map.set(String(w.target), { ...w, source: "watch" })
  }
  for (const [name, s] of Object.entries(book?.sessions ?? {})) {
    const target = String(s?.convId ?? "").trim()
    if (!target || s?.notify === false) continue
    if (map.has(target)) continue
    map.set(target, {
      target,
      name,
      issueKey: null,
      repo: "",
      number: s?.issue ?? null,
      notifyTo: "",
      source: "session",
    })
  }
  return [...map.values()]
}

// ---- 通知口径 ----

// 服务侧判定该不该发。env 默认 process.env，便于测试注入。
export function notifyDecision({ cfg, watcher, book, env = process.env, result }) {
  const notify = cfg?.notify ?? {}
  if (notify.enabled === false) return { send: false, reason: "disabled" }
  const target = String(watcher?.notifyTo ?? "").trim() || notifyTarget(notify, env)
  if (!target) return { send: false, target, reason: "no-target" }
  if (target === watcher?.target || target === watcher?.name) {
    return { send: false, target, reason: "self" }
  }

  // event 映射：跑完时用 dws.info 读最后回复并 parseResult。
  let event = "session-done"
  if (result && result.status) {
    event =
      result.status === "done" ? "done"
      : result.status === "need_decision" ? "needs-human"
      : result.status === "blocked" ? "blocked"
      : "failed"
  }

  // 有工单引用且 event 不是 session-done 时，按事件过滤；session-done 不过滤。
  if (watcher?.issueKey && event !== "session-done" && !shouldNotify(notify, event)) {
    return { send: false, target, event, reason: "event-filtered" }
  }

  // 文案：issueLike 取工单记录（watcher 上的兜底），outLike 取结论与 PR。
  let repo = watcher?.repo ?? ""
  let number = watcher?.number ?? null
  let title = ""
  let branch = ""
  let pr = null
  let prUrl = ""
  if (watcher?.issueKey) {
    const rec = book?.issue?.(watcher.issueKey) ?? {}
    const [r, n] = String(watcher.issueKey).split("#")
    repo = repo || r || ""
    number = number ?? (n ? Number(n) : null)
    title = rec.title ?? ""
    branch = rec.branch ?? ""
    pr = rec.pr ?? null
    prUrl = rec.prUrl ?? ""
  }
  const issueLike = { repo, number, title }
  const outLike = {
    state: event,
    branch,
    pr,
    prUrl,
    reason: result?.summary || result?.question || "",
  }
  return { send: true, target, event, reason: "", text: notifyText(issueLike, outLike) }
}

// ---- 服务进程 ----

export function servicePaths(cfg) {
  return {
    socket: cfg.service.socket,
    pidFile: cfg.service.pidFile,
    logFile: cfg.service.logFile,
  }
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 读 pidfile；pid 活就返回记录，否则 null。
export function singleInstanceGuard(pidFile) {
  try {
    const d = JSON.parse(fs.readFileSync(pidFile, "utf8"))
    if (d?.pid && isAlive(d.pid)) return d
  } catch {}
  return null
}

// 起 unix socket 服务。book 参数只用于初始加载，poll/write 时一律 new Book 重开。
// gitea 只在 PR 监听里用，测试可直接注入假的 { listPulls }。
export async function startServer({ cfg, book: _book, dws, log = () => {}, gitea = { listPulls } }) {
  const paths = servicePaths(cfg)
  fs.mkdirSync(path.dirname(paths.socket), { recursive: true })
  fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true })
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true })

  const state = {
    pid: process.pid,
    version: readVersion(),
    startedAt: nowIso(),
    pollSeconds: cfg.pollSeconds,
    watchers: new Map(), // target -> watcher 运行时记录
    lastPollAt: null,
    pollCount: 0,
    notifiedCount: 0,
    dwsErrors: 0,
    polling: false,
    interval: null,
    server: null,
    closed: false,
    // PR 监听运行时
    pr: { lastPollAt: null, pollCount: 0, notifiedCount: 0, polling: false, target: "", pending: 0 },
    prInterval: null,
  }

  // 初始把 book 里的监听灌进内存。
  {
    const b = new Book(cfg.stateFile)
    for (const w of watchersFor(b, cfg)) state.watchers.set(String(w.target), { ...w })
  }

  const ctx = { state, cfg, dws, gitea, log, close: null, prPoll: null }

  const server = await new Promise((resolve, reject) => {
    const srv = net.createServer((conn) => handleConnection(conn, ctx))
    const onListen = () => {
      try { fs.chmodSync(paths.socket, 0o600) } catch {}
      resolve(srv)
    }
    const onError = async (e) => {
      if (e.code === "EADDRINUSE" || e.code === "EEXIST") {
        // 残留 socket：先 ping，ping 不通才 unlink 重绑（只删自己的残留）。
        const alive = await pingOnce(paths.socket, 200).catch(() => null)
        if (alive) {
          return reject(Object.assign(new Error("socket 已被另一个服务占用"), { code: "already-running" }))
        }
        try { fs.unlinkSync(paths.socket) } catch {}
        srv.removeListener("listening", onListen)
        srv.removeListener("error", onError)
        srv.listen(paths.socket, onListen)
      } else {
        reject(e)
      }
    }
    srv.once("listening", onListen)
    srv.once("error", onError)
    srv.listen(paths.socket)
  })
  state.server = server

  // 写 pidfile（整文件覆盖，只写我们这次的记录）。
  fs.writeFileSync(
    paths.pidFile,
    JSON.stringify(
      { pid: process.pid, socket: paths.socket, startedAt: state.startedAt, version: state.version, configFile: cfg.configPath || "" },
      null,
      2
    ) + "\n"
  )

  // 轮询。
  const doPoll = async () => pollOnce(ctx)
  state.interval = setInterval(() => {
    doPoll().catch((e) => log(`poll 异常：${e.message}`))
  }, cfg.pollSeconds * 1000)
  state.interval.unref?.()

  // PR 监听：显式 opt-in（cfg.prWatch.enabled===true）才起；默认关。
  const doPrPoll = async () => prPollOnce(ctx)
  ctx.prPoll = doPrPoll
  if (cfg.prWatch?.enabled === true) {
    const intervalMs = Number(cfg.prWatch.intervalSeconds ?? 300) * 1000
    state.prInterval = setInterval(() => {
      doPrPoll().catch((e) => log(`PR 扫描异常：${e.message}`))
    }, intervalMs)
    state.prInterval.unref?.()
    state.prKick = setTimeout(() => {
      doPrPoll().catch((e) => log(`PR 扫描异常：${e.message}`))
    }, 1000)
    state.prKick.unref?.()
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    if (state.interval) clearInterval(state.interval)
    if (state.prInterval) clearInterval(state.prInterval)
    if (state.prKick) clearTimeout(state.prKick)
    await new Promise((r) => server.close(r))
    try { fs.unlinkSync(paths.socket) } catch {}
    // 只删 pidfile 是自己的那一份。
    try {
      const d = JSON.parse(fs.readFileSync(paths.pidFile, "utf8"))
      if (d?.pid === process.pid) fs.rmSync(paths.pidFile, { force: true })
    } catch {}
    log(`服务已停：pid=${process.pid}`)
  }
  ctx.close = close
  ctx.poll = doPoll

  return { server, close, poll: doPoll, prPoll: doPrPoll }
}

// PR 扫描一轮：配置里每个仓库列 open PR → 过滤作者 → 去重 → 通知最早登记的调用方。
export async function prPollOnce(ctx) {
  const { state, cfg, dws, gitea, log } = ctx
  if (cfg.prWatch?.enabled === false) return { ok: true, skipped: "disabled" }
  if (state.pr.polling) return { ok: true, skipped: "busy" }
  state.pr.polling = true
  try {
    const book = new Book(cfg.stateFile)
    // 账本里还没有调用方会话时，退回当前环境的会话 id（在豆包会话里跑服务时就是那条会话）。
    const target = prWatchTarget(cfg, book) || String(process.env.MCP_VM_CONVERSATION_ID ?? "").trim()
    state.pr.target = target
    let out
    try {
      out = await prWatchOnce({ cfg, gitea, dws, log, target })
    } catch (e) {
      log(`PR 扫描失败：${e.message}`)
      return { ok: false, error: e.message }
    }
    state.pr.lastPollAt = nowIso()
    state.pr.pollCount++
    if (out?.notified) state.pr.notifiedCount += out.notified
    state.pr.pending = out?.pending ?? 0
    return out
  } finally {
    state.pr.polling = false
  }
}

// 跑一轮：现读 book → 对每个 watcher 跑 dws.status → 该通知就 dws.info + dws.notify + 落 notified。
export async function pollOnce(ctx) {
  const { state, cfg, dws, log } = ctx
  if (state.polling) return { checked: 0, settled: 0, notified: 0, skipped: "busy" }
  state.polling = true
  const out = { checked: 0, settled: 0, notified: 0 }
  try {
    const book = new Book(cfg.stateFile)
    const watchers = watchersFor(book, cfg)
    state.watchers = new Map(watchers.map((w) => [String(w.target), { ...w }]))

    for (const w of watchers) {
      out.checked++
      const rec = state.watchers.get(String(w.target))
      let status
      try {
        status = await dws.status(w.target)
      } catch (e) {
        state.dwsErrors++
        log(`dws status ${w.target} 失败：${e.message}`)
        continue
      }
      const prev = book.notified[String(w.target)] ?? {}
      const decision = judgePoll(prev, status)
      rec.lastPhase = decision.phase
      rec.lastFingerprint = decision.fingerprint
      rec.lastPollAt = nowIso()
      if (decision.phase === "finished" || decision.phase === "settled") out.settled++
      if (!decision.shouldNotify) continue

      // 跑完且指纹变了：读最后回复 → 判 event → 决定通知 → 发。
      let result = null
      try {
        const info = await dws.info(w.target)
        const text = info?.lastReply || ""
        if (text) result = parseResult(text)
      } catch (e) {
        state.dwsErrors++
        log(`dws info ${w.target} 失败：${e.message}`)
      }

      const book2 = new Book(cfg.stateFile)
      const nd = notifyDecision({ cfg, watcher: w, book: book2, env: process.env, result })
      if (!nd.send) {
        log(`通知跳过 ${w.target}：${nd.reason}`)
        continue
      }
      try {
        await dws.notify(nd.target, nd.text)
        book2.markNotified(w.target, decision.fingerprint, {
          phase: decision.phase,
          chars: status?.chars ?? 0,
        })
        state.notifiedCount++
        out.notified++
        rec.notifiedAt = nowIso()
        log(`已通知 ${nd.target}：${w.target} 跑完（${decision.phase}/${nd.event}）`)
      } catch (e) {
        state.dwsErrors++
        log(`通知 ${nd.target} 失败：${e.message}`)
      }
    }
    state.lastPollAt = nowIso()
    state.pollCount++
  } finally {
    state.polling = false
  }
  return out
}

// ---- 连接处理 ----

function handleConnection(conn, ctx) {
  let buf = ""
  conn.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      handleLine(line, conn, ctx).catch((e) => ctx.log(`handle 异常：${e.message}`))
    }
    if (Buffer.byteLength(buf, "utf8") > MAX_FRAME_BYTES) {
      conn.write(encodeFrame({ id: null, ok: false, error: "bad_request", message: "单帧超限" }))
      buf = ""
    }
  })
  conn.on("error", () => {})
}

async function handleLine(line, conn, ctx) {
  const trimmed = line.trim()
  if (!trimmed) return
  if (Buffer.byteLength(trimmed, "utf8") > MAX_FRAME_BYTES) {
    conn.write(encodeFrame({ id: null, ok: false, error: "bad_request", message: "单帧超限" }))
    return
  }
  let req
  try {
    req = decodeFrame(trimmed)
  } catch (e) {
    conn.write(encodeFrame({ id: null, ok: false, error: "bad_request", message: e.message }))
    return
  }
  const resp = await handleRequest(ctx, req)
  conn.write(encodeFrame(resp))
}

// ---- 请求分发 ----

export async function handleRequest(ctx, req) {
  const id = req?.id
  const ok = (extra) => ({ id, ok: true, ...extra })
  const fail = (error, message) => ({ id, ok: false, error, message })
  const cmd = String(req?.cmd ?? "")

  if (cmd === "ping") {
    return ok({
      pid: process.pid,
      version: ctx.state.version,
      uptimeMs: Date.now() - new Date(ctx.state.startedAt).getTime(),
      startedAt: ctx.state.startedAt,
      pollSeconds: ctx.cfg.pollSeconds,
      watchers: ctx.state.watchers.size,
      socket: ctx.cfg.service.socket,
    })
  }

  if (cmd === "status") {
    return ok({
      pid: process.pid,
      version: ctx.state.version,
      uptimeMs: Date.now() - new Date(ctx.state.startedAt).getTime(),
      startedAt: ctx.state.startedAt,
      pollSeconds: ctx.cfg.pollSeconds,
      watchers: [...ctx.state.watchers.values()],
      lastPollAt: ctx.state.lastPollAt,
      pollCount: ctx.state.pollCount,
      notifiedCount: ctx.state.notifiedCount,
      dwsErrors: ctx.state.dwsErrors,
      logFile: ctx.cfg.service.logFile,
      socket: ctx.cfg.service.socket,
      prWatch: {
        enabled: ctx.cfg.prWatch?.enabled ?? false,
        intervalSeconds: ctx.cfg.prWatch?.intervalSeconds,
        ignoreAuthors: ctx.cfg.prWatch?.ignoreAuthors ?? [],
        target: ctx.state.pr?.target ?? "",
        lastPollAt: ctx.state.pr?.lastPollAt ?? null,
        pollCount: ctx.state.pr?.pollCount ?? 0,
        notifiedCount: ctx.state.pr?.notifiedCount ?? 0,
        pending: ctx.state.pr?.pending ?? 0,
      },
    })
  }

  if (cmd === "watch add") {
    const target = String(req?.target ?? "").trim()
    if (!target) return fail("bad_request", "watch add 需要 target")
    const entry = {
      target,
      name: String(req?.name ?? target),
      issueKey: req?.issueKey ?? null,
      repo: req?.repo ?? "",
      number: req?.number ?? null,
      notifyTo: String(req?.notifyTo ?? ""),
    }
    const book = new Book(ctx.cfg.stateFile)
    const saved = book.setWatch(entry)
    ctx.state.watchers.set(target, { ...saved, source: "watch" })
    return ok({ watcher: saved })
  }

  if (cmd === "watch remove") {
    const target = String(req?.target ?? "").trim()
    if (!target) return fail("bad_request", "watch remove 需要 target")
    const book = new Book(ctx.cfg.stateFile)
    const removed = book.delWatch(target)
    ctx.state.watchers.delete(target)
    return ok({ removed })
  }

  if (cmd === "watch list") {
    return ok({ watchers: [...ctx.state.watchers.values()] })
  }

  if (cmd === "poll") {
    const r = await ctx.poll()
    return ok(r)
  }

  if (cmd === "pr poll") {
    const r = await ctx.prPoll()
    return ok(r)
  }

  if (cmd === "pr list") {
    const book = new Book(ctx.cfg.stateFile)
    return ok({
      target: prWatchTarget(ctx.cfg, book),
      prs: Object.entries(book.prSeen).map(([key, v]) => ({ key, ...v })),
    })
  }

  if (cmd === "stop") {
    // 先回响应，再退出。
    setTimeout(() => ctx.close?.().catch(() => {}), 10)
    return ok({ stopping: true })
  }

  return fail("unknown_cmd", `未知命令：${cmd || "(空)"}`)
}

// 供 svclient / 残留检测用：短超时 ping。
export function pingOnce(socketPath, timeoutMs = 200) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    let buf = ""
    const timer = setTimeout(() => {
      try { sock.destroy() } catch {}
      reject(Object.assign(new Error("ping 超时"), { code: "timeout" }))
    }, timeoutMs)
    sock.on("connect", () => sock.write(encodeFrame({ id: "ping", cmd: "ping" })))
    sock.on("data", (d) => {
      buf += d.toString("utf8")
      const idx = buf.indexOf("\n")
      if (idx < 0) return
      clearTimeout(timer)
      try {
        const obj = JSON.parse(buf.slice(0, idx))
        if (obj.ok === false) {
          reject(Object.assign(new Error(obj.message || obj.error), { code: obj.error }))
        } else resolve(obj)
      } catch (e) {
        reject(e)
      } finally {
        try { sock.end() } catch {}
      }
    })
    sock.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
