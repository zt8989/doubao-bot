// 常驻服务：HTTP 单通道（RPC + 控制台）；按 pollSeconds 轮询 dws status，跑完才异步通知。
// 写账本一律 new Book(cfg.stateFile) 现读现写，不长期持有（run 也在写同一个 state.json）。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { nowIso, sleep, inWorkHours } from "./util.mjs"
import { Book } from "./book.mjs"
import { parseResult, deliverPrompt, noticeSessionName } from "./prompts.mjs"
import { notifyTarget, shouldNotify, notifyText, runRound, acquireLock, releaseLock } from "./orchestrator.mjs"
import { WorkflowEngine } from "./workflow/engine.mjs"
import { DoubaoSessionAdapter } from "./workflow/adapters/doubao.mjs"
import { GiteaTrackerAdapter } from "./workflow/adapters/gitea.mjs"
import { prWatchOnce, prWatchTarget, mergeFailureReason } from "./prwatch.mjs"
import { plannerDecision, plannerTarget, plannerText, loadQueue } from "./planner.mjs"
import { listPulls, mergePr, closeIssue, createPr, commentIssue } from "./gitea.mjs"
import { ConsoleStore } from "./console.mjs"
import { startConsoleHttp } from "./consolehttp.mjs"
import { fileURLToPath } from "node:url"
import { pingOnce, readPortFile } from "./svclient.mjs"

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
// 传了 maxAttempts 时，同一指纹发失败（账本里记了 attempts）允许再重试，用完次数就停；
// 不传则保持老口径（同指纹一律不发）。
export function judgePoll(prev, status, { maxAttempts = Infinity } = {}) {
  const phase = phaseOf(status)
  const fingerprint = status && Object.keys(status).length ? fingerprintOf(status) : ""
  const prevFp = prev?.fingerprint ?? ""
  const attempts = Number(prev?.attempts ?? 0)
  const sameFp = fingerprint !== "" && fingerprint === prevFp
  const retryLeft = attempts > 0 && attempts < Number(maxAttempts)
  const shouldNotify =
    (phase === "finished" || phase === "settled") &&
    fingerprint !== "" &&
    (!sameFp || retryLeft)
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

// notifyMaxAttempts：同一指纹最多发几次（默认 2：首发 + 一次补偿重试）。
export function notifyMaxAttempts(cfg) {
  const n = Number(cfg?.notify?.maxAttempts ?? cfg?.maxNotifyAttempts ?? 2)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2
}

// ---- 投递口径（每次新建会话）----

// deliveryMode：new = 每次新建一条会话投递；existing = 塞回已有会话（旧行为）。
// 缺省按 existing——手搓 cfg 的地方（测试、老调用）不改变行为；走 loadConfig 的配置默认 new。
export function deliveryMode(cfg) {
  const m = String(cfg?.deliver?.mode ?? "existing").trim().toLowerCase()
  return m === "new" ? "new" : "existing"
}

// 按仓库找回它属于哪个产品（products[].repos 里的 repo 全名或短名都能对上）。
export function productOf(cfg, repo = "") {
  const r = String(repo ?? "").trim()
  if (!r) return null
  for (const p of cfg?.products ?? []) {
    if ((p.repos ?? []).some((x) => x.repo === r || x.name === r)) return p
  }
  return null
}

// 投递上下文：产品配了自己的 promptFile / projectDir 就用产品的，否则回落顶层 deliver（老配置不变）。
export function deliverContextFor(cfg, repo = "") {
  const p = productOf(cfg, repo)
  return {
    product: p?.name ?? "",
    promptFile: p?.promptFile || String(cfg?.deliver?.promptFile ?? ""),
    projectDir: p?.projectDir || String(cfg?.deliver?.projectDir ?? ""),
  }
}

// 固定提示词只从配置给的路径读；缺配置或文件读不到都直接报错，不做内置文案兜底。
export function readFixedPrompt(cfg, repo = "") {
  const dc = deliverContextFor(cfg, repo)
  const file = String(dc.promptFile ?? "").trim()
  if (!file) {
    throw new Error(`没有给固定提示词路径（${dc.product ? `产品 ${dc.product} 的 products[].promptFile` : "配置 deliver.promptFile"}）`)
  }
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    throw new Error(`读不到固定提示词 ${file}：${e.message}`)
  }
  if (!text.trim()) throw new Error(`固定提示词是空文件：${file}`)
  return text
}

// deliverNewSession：把核对完的结论/PR 交给一条新会话。
// 首句 = 固定提示词 + 产品 + 监控项目 + 正文，按工单所属产品取提示词与项目目录。
// 记账留痕但 notify:false——它是编排者，不是被监听的执行会话，纳入监听会自己通知自己。
export async function deliverNewSession(ctx, { text = "", kind = "", repo = "", watcher = null } = {}) {
  const { cfg, dws, log = () => {} } = ctx
  const dc = deliverContextFor(cfg, repo || watcher?.repo || "")
  const fixed = readFixedPrompt(cfg, repo || watcher?.repo || "")
  // 把「在跑几条 / 上限几条」也喂给编排会话：它据此决定续跑、继续接单还是自动合并。
  const running = ctx.state?.watchers?.size
  const maxRunning = Number(cfg?.planner?.maxRunning) || null
  const prompt = deliverPrompt({ fixed, projectDir: dc.projectDir, product: dc.product, kind, text, running, maxRunning })
  const name = noticeSessionName({ prefix: cfg?.deliver?.namePrefix ?? "foreman", kind })
  const noWait = cfg?.deliver?.waitFirstReply !== true
  const out = await dws.openNew({ name, prompt, noWait })
  const convId = String(out?.convId ?? "").trim()
  new Book(cfg.stateFile).record(name, { convId, kind: "deliver", notify: false, product: dc.product })
  log(`已新建会话投递：${name}${convId ? `（${convId}）` : ""}`)
  return { session: name, convId, product: dc.product }
}

// 服务侧判定该不该发。env 默认 process.env，便于测试注入。
export function notifyDecision({ cfg, watcher, book, env = process.env, result }) {
  const notify = cfg?.notify ?? {}
  if (notify.enabled === false) return { send: false, reason: "disabled" }
  // new 模式每次都新建会话，不需要「发给谁」：目标为空不算不发，也不存在「发给自己」。
  const mode = deliveryMode(cfg)
  const target = String(watcher?.notifyTo ?? "").trim() || notifyTarget(notify, env)
  if (mode === "existing") {
    if (!target) return { send: false, target, reason: "no-target" }
    if (target === watcher?.target || target === watcher?.name) {
      return { send: false, target, reason: "self" }
    }
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
  // 会话自己开了 PR：以 RESULT 里的为准（账本里可能还没有）。
  if (result?.pr) pr = result.pr
  if (result?.prUrl) prUrl = result.prUrl
  const issueLike = { repo, number, title }
  const outLike = {
    state: event,
    session: String(watcher?.target ?? ""),
    sessionName: String(watcher?.name ?? ""),
    branch,
    pr,
    prUrl,
    merged: !!result?.merged,
    mergeError: result?.mergeError || "",
    cleanup: result?.cleanup ?? null,
    reason: result?.summary || result?.question || "",
    // 没解析出 RESULT：把最后一条回复带给编排会话（parseResult 的 none 分支把原文放在 text 里）。
    lastReply: result?.status === "none" ? String(result?.text ?? "").trim() : "",
  }
  return { send: true, target, event, reason: "", text: notifyText(issueLike, outLike) }
}

// done + 带 PR + 有自证时，由编排（foreman 自己）合并：不再让执行会话去合。
export function mergeDecision({ cfg, watcher, book, result }) {
  const merge = cfg?.merge ?? {}
  if (merge.enabled !== true) return { send: false, reason: "disabled" }
  if ((merge.by ?? "foreman") !== "foreman") return { send: false, reason: `by-${merge.by}` }
  if (result?.status !== "done") return { send: false, reason: "not-done" }
  const pr = Number(result.pr) || 0
  if (!pr) return { send: false, reason: "no-pr" }
  // 没有自证就不自动合：测试没跑过/没写结果的，交给人看。
  if (!String(result.tests ?? "").trim()) return { send: false, reason: "no-self-test" }
  const repo = watcher?.repo || String(watcher?.issueKey ?? "").split("#")[0]
  if (!repo) return { send: false, reason: "no-repo" }
  const key = `${repo}#${pr}`
  if (book?.mergeAsk?.[key]) return { send: false, key, reason: "already-asked" }
  const number = watcher?.number ?? (Number(String(watcher?.issueKey ?? "").split("#")[1]) || null)
  return {
    send: true,
    key,
    repo,
    pr,
    issueNumber: number,
    prUrl: result.prUrl ?? "",
    style: merge.style ?? "merge",
    deleteBranch: merge.deleteBranch !== false,
  }
}

// ---- 服务进程 ----

export function servicePaths(cfg) {
  return {
    pidFile: cfg.service.pidFile,
    logFile: cfg.service.logFile,
    portFile: cfg.service?.http?.portFile ?? `${path.dirname(cfg.service.pidFile)}/service.port`,
    port: Number(cfg.service?.http?.port ?? 7317),
    host: cfg.service?.http?.host || "127.0.0.1",
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

// 自动接单巡检一轮：在工作时间窗内自己捞一轮单（等价 foreman run，但不带 once，每个仓库都看）。
// 只派活、不等结果；结果仍由 pollOnce 轮询后投递。默认关（pickup.auto !== true 不动作）。
export async function pickupOnce(ctx, { run = runRound } = {}) {
  const { cfg, log, state } = ctx
  if (cfg.pickup?.auto !== true) return { ok: true, skipped: "disabled" }
  if (!inWorkHours(cfg)) return { ok: true, skipped: "off-hours" }
  if (state.pickup?.running) return { ok: true, skipped: "busy" }
  // 豆包单实例：被监听的会话还在跑就别开新会话。
  // 否则 dws open 切不到新会话，要么派单失败，要么把 kickoff 发进正在跑的那条。
  if (typeof ctx.dws?.runningMap === "function") {
    try {
      const sidebar = await ctx.dws.runningMap()
      const busyIds = [...(state.watchers?.keys() ?? [])].filter((id) => sidebar?.[id]?.running)
      if (busyIds.length) {
        log(`自动巡检：${busyIds.join("、")} 还在跑，本轮不派新会话（豆包单实例）`)
        return { ok: true, skipped: "window-busy", busy: busyIds }
      }
    } catch {
      // 侧边栏读不到不拦派单：dws open 自己有「没切到新会话就报错」的兜底。
    }
  }
  // 和 CLI 的 foreman run 抢同一把锁：两边同时捞会把同一条单派两次。
  const lockFile = path.join(path.dirname(cfg.stateFile), "run.lock")
  const lock = acquireLock(lockFile)
  if (!lock) return { ok: true, skipped: "locked" }
  state.pickup.running = true
  try {
    const book = new Book(cfg.stateFile)
    const handled = await run({
      cfg,
      book,
      dws: ctx.dws,
      log,
      maxTotal: Number(cfg.pickup.maxPerRound) || 1,
    })
    const dispatched = handled.filter((h) => h.state === "dispatched")
    const engine = ctx.engine ?? new WorkflowEngine({ cfg, session: ctx.dws, log })
    for (const h of dispatched) {
      const issueKey = `${h.repo}#${h.number}`
      await engine.emit("issue.picked", { issueKey })
      await engine.emit("session.dispatched", { issueKey, target: h.convId ?? h.agent ?? "" })
    }
    state.pickup.lastAt = nowIso()
    state.pickup.count = (state.pickup.count ?? 0) + 1
    state.pickup.lastResult = {
      dispatched: dispatched.length,
      handled: handled.map((h) => `${h.repo}#${h.number}:${h.state}`),
    }
    if (handled.length) {
      log(`自动巡检：${handled.map((h) => `${h.repo}#${h.number} ${h.state}`).join("、")}（派出 ${dispatched.length} 条）`)
    } else {
      log("自动巡检：队列里没有可接的活")
    }
    return { ok: true, dispatched: dispatched.length, handled: state.pickup.lastResult.handled }
  } finally {
    state.pickup.running = false
    releaseLock(lockFile)
  }
}

// 起服务：HTTP 单通道（CLI 的 RPC + 控制台页面同一个端口），端口写到文件里给 CLI 读。
// book 参数只用于初始加载，poll/write 时一律 new Book 重开。
// gitea 只在 PR 监听里用，测试可直接注入假的 { listPulls }。
export async function startServer({ cfg, book: _book, dws, log = () => {}, gitea = { listPulls, mergePr, closeIssue, createPr, commentIssue } }) {
  const paths = servicePaths(cfg)
  fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true })
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true })
  fs.mkdirSync(path.dirname(paths.portFile), { recursive: true })

  // 单实例：端口文件里的端口 ping 得通，说明已经有一个在跑。
  const existing = readPortFile(paths.portFile)
  if (existing) {
    try {
      await pingOnce(existing, 250)
      throw Object.assign(new Error(`服务已在运行（端口 ${existing}）`), { code: "already-running" })
    } catch (e) {
      if (e.code === "already-running") throw e
    }
  }

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
    // 自动接单巡检运行时
    pickup: { lastAt: null, count: 0, lastResult: null, running: false },
    pickupInterval: null,
  }

  // 初始把 book 里的监听灌进内存。
  {
    const b = new Book(cfg.stateFile)
    for (const w of watchersFor(b, cfg)) state.watchers.set(String(w.target), { ...w })
  }

  // 通用 workflow：生命周期 + 适配器。ctx.dws / ctx.gitea 现在是**适配器**（旧调用面保留）。
  // 豆包相关的一切（单实例护栏、侧边栏读状态、归档）都在 DoubaoSessionAdapter 里。
  const engine = new WorkflowEngine({
    cfg,
    session: new DoubaoSessionAdapter({ driver: dws, cfg, log }),
    tracker: new GiteaTrackerAdapter({ impl: gitea }),
    log,
  })
  const ctx = { state, cfg, dws: engine.session, gitea: engine.tracker, engine, log, close: null, prPoll: null, httpUrl: "", consoleStore: null }
  // 投递通道：new 模式每次新建会话；这里只做一次绑定，调用侧不用关心实现。
  ctx.deliver = (opts) => deliverNewSession(ctx, opts)

  const httpCfg = cfg.service?.http ?? {}
  const dbFile = path.resolve(String(httpCfg.db || "~/.foreman/console.db").replace(/^~/, os.homedir()))
  const consoleStore = new ConsoleStore(dbFile)
  // 前端走 Vite 构建产物（console/dist）；源码在 console/，改完跑 npm run build:console。
  const consoleDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "console", "dist")

  let consoleHttp
  try {
    consoleHttp = await startConsoleHttp({
      store: consoleStore,
      ctx,
      dir: consoleDir,
      host: paths.host,
      port: paths.port,
      log,
      onRpc: (req) => handleRequest(ctx, req),
    })
  } catch (e) {
    consoleStore.close()
    if (e.code === "EADDRINUSE") {
      throw Object.assign(new Error(`端口 ${paths.port} 被别的进程占用（不是本服务，ping 不通）`), {
        code: "port-in-use",
      })
    }
    throw e
  }

  const port = consoleHttp.port
  state.port = port
  state.server = consoleHttp.server
  ctx.httpUrl = consoleHttp.url
  ctx.consoleStore = consoleStore

  // 端口文件（纯数字一行，CLI 直接读）+ pidfile（带上端口，便于排查）。
  fs.writeFileSync(paths.portFile, `${port}\n`)
  fs.writeFileSync(
    paths.pidFile,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        http: ctx.httpUrl,
        portFile: paths.portFile,
        startedAt: state.startedAt,
        version: state.version,
        configFile: cfg.configPath || "",
      },
      null,
      2
    ) + "\n"
  )
  log(`服务已起：pid=${process.pid} http=${ctx.httpUrl} portFile=${paths.portFile}`)

  // 轮询。
  const doPoll = async () => pollOnce(ctx)
  state.interval = setInterval(() => {
    if (!inWorkHours(cfg)) return // 只在工作时间跑，下班/周末不打扰
    doPoll().catch((e) => log(`poll 异常：${e.message}`))
  }, cfg.pollSeconds * 1000)
  state.interval.unref?.()

  // PR 监听：显式 opt-in（cfg.prWatch.enabled===true）才起；默认关。
  const doPrPoll = async () => prPollOnce(ctx)
  ctx.prPoll = doPrPoll
  if (cfg.prWatch?.enabled === true) {
    const intervalMs = Number(cfg.prWatch.intervalSeconds ?? 300) * 1000
    state.prInterval = setInterval(() => {
      if (!inWorkHours(cfg)) return
      doPrPoll().catch((e) => log(`PR 扫描异常：${e.message}`))
    }, intervalMs)
    state.prInterval.unref?.()
    state.prKick = setTimeout(() => {
      if (!inWorkHours(cfg)) return
      doPrPoll().catch((e) => log(`PR 扫描异常：${e.message}`))
    }, 1000)
    state.prKick.unref?.()
  }

  // 自动接单巡检：pickup.auto===true 才起，每 pickup.intervalSeconds 一次，且只在 workHours 内跑。
  const doPickup = async () => pickupOnce(ctx)
  ctx.pickup = doPickup
  if (cfg.pickup?.auto === true) {
    const intervalMs = Number(cfg.pickup.intervalSeconds ?? 1800) * 1000
    state.pickupInterval = setInterval(() => {
      if (!inWorkHours(cfg)) return
      doPickup().catch((e) => log(`自动巡检异常：${e.message}`))
    }, intervalMs)
    state.pickupInterval.unref?.()
    // 起服务 1s 后先跑一轮：重启即开始巡检，不用等满一个间隔（同一条单靠账本去重，不会重复派）。
    state.pickupKick = setTimeout(() => {
      if (!inWorkHours(cfg)) return
      doPickup().catch((e) => log(`自动巡检异常：${e.message}`))
    }, 1000)
    state.pickupKick.unref?.()
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    if (state.interval) clearInterval(state.interval)
    if (state.prInterval) clearInterval(state.prInterval)
    if (state.prKick) clearTimeout(state.prKick)
    if (state.pickupInterval) clearInterval(state.pickupInterval)
    if (state.pickupKick) clearTimeout(state.pickupKick)
    await new Promise((r) => consoleHttp.server.close(r))
    consoleStore.close()
    // 只删自己的端口文件（端口号对得上才删）。
    try {
      if (Number(fs.readFileSync(paths.portFile, "utf8").trim()) === port) fs.unlinkSync(paths.portFile)
    } catch {}
    // 只删 pidfile 是自己的那一份。
    try {
      const d = JSON.parse(fs.readFileSync(paths.pidFile, "utf8"))
      if (d?.pid === process.pid) fs.rmSync(paths.pidFile, { force: true })
    } catch {}
    log(`服务已停：pid=${process.pid}`)
  }
  ctx.close = close
  ctx.poll = doPoll

  return { server: consoleHttp.server, close, poll: doPoll, prPoll: doPrPoll, pickup: doPickup, port, portFile: paths.portFile, http: ctx.httpUrl }
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
      // new 模式：PR 待合并也交给一条新会话（首句带固定提示词）；existing 才回已有会话。
      const deliver = deliveryMode(cfg) === "new" ? ctx.deliver : null
      out = await prWatchOnce({ cfg, gitea, dws, log, target, deliver })
    } catch (e) {
      log(`PR 扫描失败：${e.message}`)
      return { ok: false, error: e.message }
    }
    state.pr.lastPollAt = nowIso()
    state.pr.pollCount++
    if (out?.notified) state.pr.notifiedCount += out.notified
    state.pr.pending = out?.pending ?? 0
    // 落一次库：按工单号去重，重复扫到只更新状态；polls 表留扫描痕迹。
    if (ctx.consoleStore) {
      try {
        const scanBook = new Book(cfg.stateFile)
        const synced = ctx.consoleStore.sync(scanBook)
        state.pr.lastNewPrs = synced.newPrs
        ctx.consoleStore.recordPoll(synced)
      } catch (e) {
        log(`控制台落库失败：${e.message}`)
      }
    }
    return out
  } finally {
    state.pr.polling = false
  }
}

// 跑一轮：现读 book → 对每个 watcher 跑 dws.status → 该通知就 dws.info + dws.notify + 落 notified。
export async function pollOnce(ctx) {
  const { state, cfg, dws, log, gitea } = ctx
  // 直接构造 ctx 的调用方（测试/脚本）没有 engine 时补一个，保证流程事件照样发。
  const engine = ctx.engine ?? new WorkflowEngine({ cfg, session: dws, tracker: gitea, log })
  if (state.polling) return { checked: 0, settled: 0, notified: 0, skipped: "busy" }
  state.polling = true
  const out = { checked: 0, settled: 0, notified: 0 }
  try {
    const book = new Book(cfg.stateFile)
    const watchers = watchersFor(book, cfg)
    state.watchers = new Map(watchers.map((w) => [String(w.target), { ...w }]))

    // 先读一次侧边栏（不切窗口）：还在跑的会话只看这里，不逐条 dws status。
    // 否则每 20s 轮询都会把用户窗口 goto 到被监听的会话上（表现为「一直被切回某条会话」）。
    let sidebar = null
    if (typeof dws.runningMap === "function") {
      try {
        sidebar = await dws.runningMap()
      } catch (e) {
        // 读不到侧边栏就退化为老行为（逐条 status），不因此漏掉通知。
        log(`读侧边栏状态失败，本轮退回逐条 status：${e.message}`)
      }
    }

    for (const w of watchers) {
      out.checked++
      const rec = state.watchers.get(String(w.target))
      const side = sidebar?.[String(w.target)]
      if (side?.running) {
        rec.lastPhase = "running"
        rec.lastPollAt = nowIso()
        continue
      }
      let status
      try {
        status = await dws.status(w.target)
      } catch (e) {
        state.dwsErrors++
        log(`dws status ${w.target} 失败：${e.message}`)
        continue
      }
      const prev = book.notified[String(w.target)] ?? {}
      // 同一指纹最多尝试 maxAttempts 次：dws.send 会「消息到了却报发送失败」，
      // 不封顶就会每轮 poll 补发一次，把调用方会话刷成重复通知。
      const decision = judgePoll(prev, status, { maxAttempts: notifyMaxAttempts(cfg) })
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

      // 出结论就推进工单状态：done → pr-open/done，其余进各自的停态（failed 还能 retry）。
      if (result && w.issueKey) {
        const st = result.status === "done" ? (Number(result.pr) ? "pr-open" : "done")
          : result.status === "need_decision" ? "needs-human"
          : result.status === "blocked" ? "blocked"
          : result.status === "failed" ? "failed" : ""
        if (st) {
          const patch = { state: st }
          if (Number(result.pr)) { patch.pr = Number(result.pr); patch.prUrl = result.prUrl ?? "" }
          new Book(cfg.stateFile).setIssue(w.issueKey, patch)
          await engine.emit("issue.concluded", { issueKey: w.issueKey, target: w.target, status: result.status, pr: result.pr ?? null })
        }
      }

      // 会话自己 push + 开 PR；合并由编排做（冲突/失败只记日志、不 force merge）。
      const bookM = new Book(cfg.stateFile)
      const md = mergeDecision({ cfg, watcher: w, book: bookM, result })
      let merged = false
      let mergeError = ""
      if (md.send) {
        try {
          await gitea.mergePr(md.repo, md.pr, { style: md.style, deleteBranch: md.deleteBranch })
          if (md.issueNumber) {
            try { await gitea.closeIssue(md.repo, md.issueNumber) } catch (e) {
              log(`合并后关单失败 ${md.repo}#${md.issueNumber}：${e.message}`)
            }
          }
          bookM.markMergeAsked(md.key, { pr: md.pr, url: md.prUrl, status: "merged" })
          merged = true
          out.merged = (out.merged ?? 0) + 1
          log(`已合并 ${md.repo}#${md.pr}（${md.key}）`)
        } catch (e) {
          mergeError = await mergeFailureReason({ gitea, repo: md.repo, pr: md.pr, error: e })
          // 失败也记账：不 force merge，也不每轮重试同一张 PR。
          bookM.markMergeAsked(md.key, { pr: md.pr, url: md.prUrl, status: "failed", error: mergeError })
          log(`合并失败 ${md.repo}#${md.pr}：${mergeError}`)
        }
      } else if (md.reason && !["disabled", "already-asked"].includes(md.reason)) {
        log(`跳过自动合并 ${w.target}：${md.reason}`)
      }
      const resultOut = result ? { ...result, merged, mergeError } : result

      // 合并成功后的通用收尾（workflow 引擎）：清工作区 → workspace.cleaned → pr.merged
      // （豆包 adapter 在 pr.merged 上归档执行会话）。失败只记 notes，不推翻 merged。
      if (merged && resultOut) {
        resultOut.cleanup = await engine.afterMerge({ watcher: w, merge: md, book: bookM })
      }

      const book2 = new Book(cfg.stateFile)
      const nd = notifyDecision({ cfg, watcher: w, book: book2, env: process.env, result: resultOut })

      // 续接内容并进同一条通知：done 就带 PR + 剩余列表，不是 done 就带“去看一下”。
      let planBlock = ""
      let planNote = ""
      let planKind = ""
      const planKey = `${w.target}#${decision.fingerprint}`
      try {
        const pb = new Book(cfg.stateFile)
        const pd = plannerDecision({ cfg, book: pb, result: resultOut, key: planKey })
        if (pd.send) {
          let issues = []
          if (pd.kind === "continue") {
            issues = await loadQueue({ cfg, book: pb, gitea, limit: Number(cfg.planner?.listLimit) || 5 })
            if (!issues.length) pd.send = false
          }
          if (pd.send) {
            planBlock = plannerText({
              cfg, kind: pd.kind, watcher: w, result: resultOut,
              running: pd.running, maxRunning: pd.maxRunning, issues,
            })
            planKind = pd.kind
            planNote = pd.kind === "continue" ? `续接 ${issues.length} 条` : "催查看"
          }
        }
      } catch (e) {
        state.dwsErrors++
        log(`续接内容生成失败：${e.message}`)
      }

      const mode = deliveryMode(cfg)
      const target = String(nd.send ? nd.target : "") || (planBlock ? plannerTarget(cfg, new Book(cfg.stateFile), process.env) : "")
      const text = [nd.send ? nd.text : "", planBlock].filter(Boolean).join("\n\n")
      if (!text) {
        log(`通知跳过 ${w.target}：${nd.reason || "empty"}`)
        continue
      }
      // existing 才需要「发给谁」；new 模式每次都新建会话，跟哪个会话在跑无关。
      if (mode === "existing" && (!target || target === String(w.target))) {
        log(`通知跳过 ${w.target}：${nd.reason || "no-target"}`)
        continue
      }
      // 先记账再发：发送本身可能几十秒，崩溃/假失败时不能让下一轮从零重发。
      book2.markAttempted(w.target, decision.fingerprint, {
        phase: decision.phase,
        chars: status?.chars ?? 0,
      })
      let sentTo = target
      try {
        if (mode === "new") {
          const out = await ctx.deliver({ text, kind: "工单结论", watcher: w })
          sentTo = out?.session || out?.convId || "新会话"
        } else {
          await dws.notify(target, text)
        }
        book2.markNotified(w.target, decision.fingerprint, {
          phase: decision.phase,
          chars: status?.chars ?? 0,
        })
        if (planBlock) new Book(cfg.stateFile).markPlanner(planKey, { kind: planKind, target: sentTo })
        state.notifiedCount++
        out.notified++
        rec.notifiedAt = nowIso()
        await engine.emit("notice.delivered", { issueKey: w.issueKey ?? "", target: sentTo, kind: planKind || nd.event })
        log(`已通知 ${sentTo}：${w.target} 跑完（${decision.phase}/${nd.event}）${planNote ? `，${planNote}` : ""}`)
      } catch (e) {
        state.dwsErrors++
        const n = notifyMaxAttempts(cfg)
        const led = book2.notified[String(w.target)]
        if (led) {
          led.lastError = e.message
          book2.save()
        }
        log(`通知 ${sentTo || "新会话"} 失败（第 ${led?.attempts ?? 1}/${n} 次）：${e.message}`)
        if ((led?.attempts ?? 1) >= n) {
          log(`通知 ${sentTo || "新会话"} 放弃重试：${w.target} 同指纹已试 ${n} 次`)
        }
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
      planner: { enabled: ctx.cfg.planner?.enabled === true, maxRunning: Number(ctx.cfg.planner?.maxRunning) || 2 },
      workHours: { config: ctx.cfg.workHours ?? null, active: inWorkHours(ctx.cfg), now: nowIso() },
      deliver: {
        mode: deliveryMode(ctx.cfg),
        promptFile: ctx.cfg.deliver?.promptFile ?? "",
        projectDir: ctx.cfg.deliver?.projectDir ?? "",
        waitFirstReply: ctx.cfg.deliver?.waitFirstReply === true,
      },
      http: ctx.httpUrl || "",
      port: ctx.state.port ?? null,
      portFile: ctx.cfg.service?.http?.portFile ?? "",
    })
  }

  // PR / 工单写操作收口到 foreman：agent 只调这几个，账本与控制台才有数据。
  if (cmd === "pr open") {
    const repo = String(req.repo ?? "").trim()
    // 基线取配置 repos[].base；请求里显式给了才覆盖。
    const base = String(req.base ?? "").trim() || (ctx.cfg.repos ?? []).find((r) => r.repo === repo)?.base || ""
    const head = String(req.head ?? "").trim()
    const title = String(req.title ?? "").trim()
    if (!repo || !head || !title) return fail("bad-request", "pr open 需要 repo / head / title")
    if (!base) return fail("bad-request", `配置里没有 ${repo} 的 repos[].base，也没给 --base`)
    let pr
    try {
      pr = await ctx.gitea.createPr({ repo, base, head, title, body: String(req.body ?? "") })
    } catch (e) {
      return fail("gitea-error", e.message)
    }
    const number = Number(pr.number ?? 0)
    if (!number) return fail("no-pr-number", `PR 建了但拿不到编号：${pr.url ?? ""}`)
    const b = new Book(ctx.cfg.stateFile)
    b.markPrSeen(`${repo}#${number}`, {
      repo,
      number,
      title,
      url: pr.url ?? "",
      author: ctx.cfg.pickup?.me ?? "",
      skipped: "self",
    })
    const issueNo = Number(req.issue ?? 0)
    if (issueNo) b.setIssue(`${repo}#${issueNo}`, { state: "pr-open", title, pr: number, prUrl: pr.url ?? "", branch: head })
    ctx.consoleStore?.event({
      kind: "pr_open", key: `${repo}#${number}`, repo, number,
      to: "open",
      detail: `${base} ← ${head}${issueNo ? ` · 工单 #${issueNo}` : ""}`,
    })
    // 立刻落库，控制台不用等下一轮同步。
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    ctx.log?.(`PR 建好 ${repo}#${number} ${pr.url ?? ""}（走 foreman）`)
    return ok({ repo, pr: number, url: pr.url ?? "", issue: issueNo || null })
  }

  if (cmd === "pr merge") {
    const repo = String(req.repo ?? "").trim()
    const number = Number(req.number ?? 0)
    if (!repo || !number) return fail("bad-request", "pr merge 需要 repo / number")
    const style = String(req.style ?? ctx.cfg.merge?.style ?? "merge")
    const deleteBranch = req.deleteBranch !== undefined ? req.deleteBranch !== false : ctx.cfg.merge?.deleteBranch !== false
    try {
      await ctx.gitea.mergePr(repo, number, { style, deleteBranch })
    } catch (e) {
      const reason = await mergeFailureReason({ gitea: ctx.gitea, repo, pr: number, error: e })
      try {
        new Book(ctx.cfg.stateFile).markMergeAsked(`${repo}#${number}`, { pr: number, status: "failed", error: reason })
      } catch {}
      ctx.log?.(`合并失败 ${repo}#${number}：${reason}`)
      return fail("merge-failed", reason)
    }
    const issueNo = Number(req.issue ?? 0)
    const b = new Book(ctx.cfg.stateFile)
    b.markMergeAsked(`${repo}#${number}`, { pr: number, url: String(req.url ?? ""), status: "merged" })
    if (issueNo) {
      try { await ctx.gitea.closeIssue(repo, issueNo) } catch (e) { ctx.log?.(`关单 ${repo}#${issueNo} 失败：${e.message}`) }
      b.setIssue(`${repo}#${issueNo}`, { state: "done", pr: number })
    }
    ctx.consoleStore?.event({
      kind: "pr_merge", key: `${repo}#${number}`, repo, number,
      to: "merged", detail: `${style}${issueNo ? ` · 关单 #${issueNo}` : ""}`,
    })
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    ctx.log?.(`已合并 ${repo}#${number}${issueNo ? `，关单 #${issueNo}` : ""}（走 foreman）`)
    return ok({ repo, number, merged: true, issue: issueNo || null })
  }

  if (cmd === "issue comment") {
    const repo = String(req.repo ?? "").trim()
    const number = Number(req.number ?? 0)
    const body = String(req.body ?? "")
    if (!repo || !number || !body.trim()) return fail("bad-request", "issue comment 需要 repo / number / body")
    try {
      await ctx.gitea.commentIssue(repo, number, body)
    } catch (e) {
      return fail("gitea-error", e.message)
    }
    new Book(ctx.cfg.stateFile).setIssue(`${repo}#${number}`, { note: body.slice(0, 300) })
    ctx.consoleStore?.event({
      kind: "issue_comment", key: `${repo}#${number}`, repo, number,
      detail: body.slice(0, 200),
    })
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    return ok({ repo, number, commented: true })
  }

  if (cmd === "issue close") {
    const repo = String(req.repo ?? "").trim()
    const number = Number(req.number ?? 0)
    if (!repo || !number) return fail("bad-request", "issue close 需要 repo / number")
    try {
      await ctx.gitea.closeIssue(repo, number)
    } catch (e) {
      return fail("gitea-error", e.message)
    }
    new Book(ctx.cfg.stateFile).setIssue(`${repo}#${number}`, { state: "done" })
    ctx.consoleStore?.event({ kind: "issue_close", key: `${repo}#${number}`, repo, number, to: "done" })
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    return ok({ repo, number, closed: true })
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
      http: ctx.httpUrl || "",
      port: ctx.state.port ?? null,
      portFile: ctx.cfg.service?.http?.portFile ?? "",
      workHours: {
        config: ctx.cfg.workHours ?? null,
        active: inWorkHours(ctx.cfg),
        now: nowIso(),
      },
      deliver: {
        mode: deliveryMode(ctx.cfg),
        promptFile: ctx.cfg.deliver?.promptFile ?? "",
        projectDir: ctx.cfg.deliver?.projectDir ?? "",
        waitFirstReply: ctx.cfg.deliver?.waitFirstReply === true,
      },
      pickup: {
        auto: ctx.cfg.pickup?.auto === true,
        intervalSeconds: ctx.cfg.pickup?.intervalSeconds,
        maxPerRound: ctx.cfg.pickup?.maxPerRound,
        lastAt: ctx.state.pickup?.lastAt ?? null,
        count: ctx.state.pickup?.count ?? 0,
        running: ctx.state.pickup?.running === true,
        lastResult: ctx.state.pickup?.lastResult ?? null,
      },
      // 产品分组：每个产品一套仓库 + 自己的提示词/监控目录。
      products: (ctx.cfg.products ?? []).map((p) => ({
        name: p.name,
        repos: p.repos.map((r) => r.repo),
        promptFile: p.promptFile || ctx.cfg.deliver?.promptFile || "",
        projectDir: p.projectDir || ctx.cfg.deliver?.projectDir || "",
      })),
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
      workflow: {
        stages: ctx.engine?.stages() ?? [],
        recent: (ctx.engine?.lifecycle.history ?? []).slice(-12),
        archiveAfterMerge: ctx.cfg.workflow?.archiveAfterMerge !== false,
      },
    })
  }

  if (cmd === "watch add") {
    const target = String(req?.target ?? "").trim()
    if (!target) return fail("bad_request", "watch add 需要 target")
    const repo = String(req?.repo ?? "")
    const number = req?.number ?? null
    const entry = {
      target,
      name: String(req?.name ?? target),
      // repo + number 能推出 issueKey 就写上：后面推进工单状态、合并后关单都靠它，
      // 缺了会出现「PR 合了、通知也发了，但工单还挂在 working」。
      issueKey: req?.issueKey ?? (repo && number ? `${repo}#${number}` : null),
      repo,
      number,
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

  // 手动催一轮自动巡检（不用等下一个间隔）。
  if (cmd === "pickup") {
    const r = await ctx.pickup()
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

export { pingOnce }
