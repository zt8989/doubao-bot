// 常驻服务：HTTP 单通道（RPC + 控制台）；按 pollSeconds 轮询 dws status，跑完才异步通知。
// 写账本一律 new Book(cfg.stateFile) 现读现写，不长期持有（run 也在写同一个 state.json）。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { nowIso, sleep, inWorkHours } from "./util.mjs"
import { Book } from "./book.mjs"
import { parseResult, deliverPrompt, noticeSessionName, issueBranch } from "./prompts.mjs"
import { builtinPrompt } from "./builtin-prompts.mjs"
import { notifyTarget, shouldNotify, notifyText, runRound, acquireLock, releaseLock } from "./orchestrator.mjs"
import { findWorkspace, mergeWorkspace, upsertPr } from "./workspaces.mjs"
import { WorkflowEngine } from "./workflow/engine.mjs"
import { NODE_TEARDOWN, runNodeCleanup, resolveIssueKey, issueKeyForPr } from "./workflow/cleaners.mjs"
import { DoubaoSessionAdapter } from "./workflow/adapters/doubao.mjs"
import { GiteaTrackerAdapter } from "./workflow/adapters/gitea.mjs"
import { prWatchOnce, prWatchTarget, mergeFailureReason } from "./prwatch.mjs"
import { inflightIssues } from "./planner.mjs"
import { listPulls, mergePr, closeIssue, createPr, commentIssue } from "./gitea.mjs"
import { ConsoleStore } from "./console.mjs"
import { listSchedules, applySchedules, persistSchedules, cronOf } from "./schedules.mjs"
import { nextCronTime } from "./cron.mjs"
import { startOperation, finishOperation } from "./operations.mjs"
import { startConsoleHttp } from "./consolehttp.mjs"
import { fileURLToPath } from "node:url"
import { pingOnce, readPortFile } from "./svclient.mjs"
import { worktreeRemove, statusPorcelain, git, createWorktree } from "./gitx.mjs"

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

// judgePoll：跑完 + 指纹相对上次已处理的指纹变化，才走一次 notify 节点（当前只落痕）。
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
// mergePromptFile 是合并会话的提示词：产品给了就用，没给依次回落 deliver.mergePromptFile、promptFile。
export function deliverContextFor(cfg, repo = "") {
  const p = productOf(cfg, repo)
  const promptFile = p?.promptFile || String(cfg?.deliver?.promptFile ?? "")
  return {
    product: p?.name ?? "",
    promptFile,
    mergePromptFile: p?.mergePromptFile || String(cfg?.deliver?.mergePromptFile ?? "") || promptFile,
    projectDir: p?.projectDir || String(cfg?.deliver?.projectDir ?? ""),
  }
}

// 编排提示词：配置给了路径就读那份（运行时副本、人工可改）；没给就用代码内置的。
// 给了路径但读不到 / 是空文件，仍然直接报错，不悄悄退回内置（那样人改了却不知道没生效）。
// lane=merge 读合并会话提示词，其余读派单会话提示词。
export function readFixedPrompt(cfg, repo = "", { lane = "dispatch" } = {}) {
  const dc = deliverContextFor(cfg, repo)
  const file = String((lane === "merge" ? dc.mergePromptFile : dc.promptFile) ?? "").trim()
  if (!file) return builtinPrompt(lane)
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
// 两条通道各投各的：派单会话（续跑/接单）与合并会话（合 PR）用不同提示词、不同命名。
// 记账留痕但 notify:false——它们是编排者，不是被监听的执行会话，纳入监听会自己通知自己。
export async function deliverNewSession(ctx, { text = "", kind = "", repo = "", watcher = null, lane = "dispatch" } = {}) {
  const { cfg, dws, log = () => {} } = ctx
  const laneName = lane === "merge" ? "merge" : "dispatch"
  const dc = deliverContextFor(cfg, repo || watcher?.repo || "")
  const fixed = readFixedPrompt(cfg, repo || watcher?.repo || "", { lane: laneName })
  // 把「在跑几条 / 上限几条」喂给派单会话：它据此决定续跑还是继续接单。
  const running = inflightIssues(new Book(cfg.stateFile)).length
  const maxRunning = Number(cfg?.pickup?.maxRunning) || 2
  const prompt = deliverPrompt({
    fixed, projectDir: dc.projectDir, product: dc.product, kind, text,
    running, maxRunning, lane: laneName,
  })
  const name = noticeSessionName({ prefix: cfg?.deliver?.namePrefix ?? "foreman", kind: laneName === "merge" ? "合并" : "派单" })
  const noWait = cfg?.deliver?.waitFirstReply !== true
  const key = watcher?.issueKey || repo || ""
  const op = startOperation(ctx, "deliver", `投递${kind || "通知"}`, { key, detail: name })
  try {
    const out = await dws.openNew({ name, prompt, noWait })
    const convId = String(out?.convId ?? "").trim()
    // notice 记触发类型：合并判断链路只消费「PR待合并」这条会话交回的 RESULT；
    // 「合并完成」那类会话只做汇报，不再触发一次合并。
    new Book(cfg.stateFile).record(name, {
      convId, kind: `deliver:${laneName}`, notify: false, product: dc.product,
      notice: String(kind ?? ""), repo: String(repo || watcher?.repo || ""),
      createdAt: nowIso(),
    })
    log(`已新建${laneName === "merge" ? "合并" : "派单"}会话投递：${name}${convId ? `（${convId}）` : ""}`)
    finishOperation(ctx, op, "success", `${name}${convId ? ` · 会话 ${convId}` : ""}`)
    return { session: name, convId, product: dc.product, lane: laneName }
  } catch (e) {
    finishOperation(ctx, op, "failed", e.message)
    throw e
  }
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
  let workspaces = []
  if (watcher?.issueKey) {
    const rec = book?.issue?.(watcher.issueKey) ?? {}
    const [r, n] = String(watcher.issueKey).split("#")
    repo = repo || r || ""
    number = number ?? (n ? Number(n) : null)
    title = rec.title ?? ""
    branch = rec.branch ?? ""
    pr = rec.pr ?? null
    prUrl = rec.prUrl ?? ""
    workspaces = Array.isArray(rec.workspaces) ? rec.workspaces : []
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
    workspaces,
    merged: !!result?.merged,
    mergeQueued: !!result?.mergeQueued,
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
  // 一工程一工作区：跨工程的单有几条 PR，自动合并只认一条会半合，交编排逐条核对后再合。
  if (Array.isArray(result?.prs) && result.prs.length > 1) {
    return { send: false, reason: `multi-pr:${result.prs.length}` }
  }
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
// force 是页面上的「立即执行」：只跳过「没开」「不在工作时间」两道闸，
// 容量 / busy / 锁 / 节点暂停这些保护照旧，避免重复派单。
export async function pickupOnce(ctx, { run = runRound, force = false } = {}) {
  const { cfg, log, state } = ctx
  if (cfg.pickup?.auto !== true && !force) return { ok: true, skipped: "disabled" }
  if (!force && !inWorkHours(cfg)) return { ok: true, skipped: "off-hours" }
  if (state.pickup?.running) return { ok: true, skipped: "busy" }
  // 接单节点被暂停：只停自动接单这一步，整条 workflow 不会停（在跑的单照常推进）。
  if (ctx.engine?.paused?.("pickup")) return { ok: true, skipped: "node-paused" }
  // 容量按「workflow 状态」算：在跑的『自有工单』流程实例最多 maxRunning（默认 2）条。
  // 账本里 planned/working 的单数只作兜底（服务重启后 engine 会从账本恢复实例，两边基本一致）。
  const maxRunning = Number(cfg.pickup?.maxRunning) || 2
  const runningOwn = ctx.engine?.active?.("own")?.length ?? 0
  const inflight = Math.max(inflightIssues(new Book(cfg.stateFile)).length, runningOwn)
  if (inflight >= maxRunning) {
    return { ok: true, skipped: "slots-full", running: inflight, maxRunning }
  }
  // 保守开关（默认关）：豆包单实例下，被监听的会话还在跑就别开新会话。
  // 关掉才能同时有 2 张单在跑；窗口互相抢时在配置里打开 pickup.pauseWhileRunning。
  if (cfg.pickup?.pauseWhileRunning === true && typeof ctx.dws?.runningMap === "function") {
    try {
      const sidebar = await ctx.dws.runningMap()
      const busyIds = [...(state.watchers?.keys() ?? [])].filter((id) => sidebar?.[id]?.running)
      if (busyIds.length) {
        log(`自动巡检：${busyIds.join("、")} 还在跑，本轮不派新会话（pickup.pauseWhileRunning）`)
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
  // 一轮补几个空槽：派活动作仍串行，所以取 min(剩余容量, pickup.maxPerRound)。
  const capacity = Math.max(1, maxRunning - inflight)
  const maxTotal = Math.min(capacity, Number(cfg.pickup.maxPerRound) || capacity)
  state.pickup.running = true
  const op = startOperation(ctx, "pickup", "巡检并派单", { detail: `在跑 ${inflight}/${maxRunning} · 本轮最多 ${maxTotal} 条` })
  try {
    const book = new Book(cfg.stateFile)
    const handled = await run({
      cfg,
      book,
      dws: ctx.dws,
      log,
      consoleStore: ctx.consoleStore,
      maxTotal,
    })
    const dispatched = handled.filter((h) => h.state === "dispatched")
    const engine = ctx.engine ?? new WorkflowEngine({ cfg, session: ctx.dws, log })
    for (const h of dispatched) {
      const issueKey = `${h.repo}#${h.number}`
      await engine.emit("issue.picked", { issueKey, workflow: "own" })
      await engine.emit("session.dispatched", { issueKey, target: h.convId ?? h.agent ?? "", workflow: "own" })
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
  } catch (e) {
    finishOperation(ctx, op, "failed", e.message)
    throw e
  } finally {
    if (ctx.consoleStore?.operationGet?.(op)?.status === "running") {
      const r = state.pickup.lastResult
      finishOperation(ctx, op, "success", r ? `派出 ${r.dispatched} 条${r.handled.length ? ` · ${r.handled.join("、")}` : " · 队列里没有可接的活"}` : "本轮结束")
    }
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
    // 合并通道运行时（与派单通道分开：各排各的队，各用各的并发）
    merge: { lastSweepAt: null, sweeps: 0, lastResult: null, interval: null, kick: null },
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
  // 合并通道已取消：合并不再排独立的 lane/定时任务，`foreman pr merge` 直接执行，
  // 用一条进程内的串行链（ctx.mergeChain）兜住并发，账本照样写。
  // 投递通道：new 模式每次新建会话；这里只做一次绑定，调用侧不用关心实现。
  ctx.deliver = (opts) => deliverNewSession(ctx, opts)

  // 服务重启后把账本里在跑的工单补成流程实例：容量按实例算，不补就会当成 0 又重复派单。
  try {
    engine.restore(new Book(cfg.stateFile))
  } catch (e) {
    log(`恢复流程实例失败：${e.message}`)
  }

  const httpCfg = cfg.service?.http ?? {}
  const dbFile = path.resolve(String(httpCfg.db || "~/.foreman/console.db").replace(/^~/, os.homedir()))
  const consoleStore = new ConsoleStore(dbFile)
  consoleStore.recoverOperations()
  // workflow 里的清理、归档也走同一本操作日志。
  engine.consoleStore = consoleStore
  engine.session.consoleStore = consoleStore
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

  const doPrPoll = async () => prPollOnce(ctx)
  ctx.prPoll = doPrPoll
  const doPickup = async () => pickupOnce(ctx)
  ctx.pickup = doPickup
  // 页面上的「立即执行」：不看开关和 cron 现在是什么状态，立刻跑一轮这类任务。
  // 只 bypass「没开 / 不在工作时间」；容量、busy、锁、节点暂停这些保护仍然生效。
  ctx.runSchedule = async (id) => {
    if (id === "pickup") return pickupOnce(ctx, { force: true })
    if (id === "prWatch") return prPollOnce(ctx, { force: true })
    // 续接调度跟着会话轮询走，立即执行就是立刻跑一轮轮询（收工的会话该催就催）。
    if (id === "planner") return pollOnce(ctx)
    throw Object.assign(new Error(`${id} 没有可以立即执行的动作`), { code: "schedule_not_runnable" })
  }
  // 合并不再有定时任务（合并通道已取消）：`foreman pr merge` 当场执行，合完直接返回。

  // PR 扫描（现在是「他人 PR 扫描」）、自动接单都由 cron 驱动：页面上改表达式立刻重排，不用重启服务。
  // 老的 intervalSeconds 仍会读，但没配 cron 时折成分钟级 cron（见 cronOf）。合并通道已取消。
  const armSchedules = () => {
    for (const k of ["prInterval", "prKick", "pickupInterval", "pickupKick"]) {
      if (state[k]) clearTimeout(state[k])
      state[k] = null
    }
    state.pr.nextAt = ""
    state.pickup.nextAt = ""

    const TIMERS = { pr: ["prInterval", "他人 PR 扫描"], pickup: ["pickupInterval", "自动巡检"] }
    const armOne = (kind, expr, run) => {
      const [timerKey, label] = TIMERS[kind]
      let next
      try {
        next = nextCronTime(expr)
      } catch (e) {
        log(`${label}的 cron 不合法（${expr}）：${e.message}`)
        return
      }
      if (!next) {
        log(`${label}的 cron 两年内没有触发点：${expr}`)
        return
      }
      state[kind].nextAt = next.toISOString()
      state[timerKey] = setTimeout(() => {
        state[timerKey] = null
        if (inWorkHours(cfg)) run().catch((e) => log(`${label}异常：${e.message}`))
        if (!state.closed) armOne(kind, expr, run)
      }, Math.max(0, next.getTime() - Date.now()))
      state[timerKey].unref?.()
    }

    // PR 监听：显式 opt-in（cfg.prWatch.enabled===true）才起；默认关。
    if (cfg.prWatch?.enabled === true) {
      armOne("pr", cronOf(cfg, "prWatch"), doPrPoll)
      state.prKick = setTimeout(() => {
        if (!inWorkHours(cfg)) return
        doPrPoll().catch((e) => log(`PR 扫描异常：${e.message}`))
      }, 1000)
      state.prKick.unref?.()
    }

    // 自动接单巡检：pickup.auto===true 才起，且只在 workHours 内跑。
    if (cfg.pickup?.auto === true) {
      armOne("pickup", cronOf(cfg, "pickup"), doPickup)
      // 开启后 1s 先跑一轮：页面上点开就不用等到下一个 cron 点（同一条单靠账本去重，不会重复派）。
      state.pickupKick = setTimeout(() => {
        if (!inWorkHours(cfg)) return
        doPickup().catch((e) => log(`自动巡检异常：${e.message}`))
      }, 1000)
      state.pickupKick.unref?.()
    }

    // 合并通道已取消：这里不再挂「合并」定时任务（合并由 pr merge 当场执行）。
  }
  armSchedules()

  // 页面上启停定时任务：改内存 cfg → 落盘 config.json → 立刻重排定时器。
  const schedulesView = () => listSchedules(cfg, state)
  ctx.schedules = schedulesView
  ctx.applySchedules = (patch = {}) => {
    applySchedules(cfg, patch)
    try {
      if (persistSchedules(cfg.configPath, patch, cfg)) log(`定时任务已写回配置：${Object.keys(patch).join(",")}`)
    } catch (e) {
      log(`定时任务写回配置失败：${e.message}`)
    }
    armSchedules()
    const view = schedulesView()
    log(`定时任务开关：${view.map((s) => `${s.id}=${s.enabled ? "on" : "off"}`).join(" ")}`)
    return view
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    if (state.interval) clearInterval(state.interval)
    if (state.prInterval) clearTimeout(state.prInterval)
    if (state.prKick) clearTimeout(state.prKick)
    if (state.pickupInterval) clearTimeout(state.pickupInterval)
    if (state.pickupKick) clearTimeout(state.pickupKick)
    if (state.mergeInterval) clearTimeout(state.mergeInterval)
    if (state.mergeKick) clearTimeout(state.mergeKick)
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
// force 是页面上的「立即执行」：即使 prWatch.enabled 是 false（默认关）也扫这一轮。
export async function prPollOnce(ctx, { force = false } = {}) {
  const { state, cfg, dws, gitea, log } = ctx
  if (cfg.prWatch?.enabled === false && !force) return { ok: true, skipped: "disabled" }
  if (state.pr.polling) return { ok: true, skipped: "busy" }
  // 「他人 PR 扫描」节点被暂停：这一轮不扫，已经扫到的 PR 照常由编排核对合并。
  if (ctx.engine?.paused?.("scan")) return { ok: true, skipped: "node-paused" }
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
    // 扫到别人的 PR 就进「他人 PR」流程：每条都推一次 scan 阶段，交给编排核对后合。
    for (const key of out?.prs ?? []) {
      await ctx.engine?.emit("pr.scanned", { key, workflow: "review" })
    }
    // 通知会话收尾：它报过的 PR 都合完了就归档，别把「PR待合并」会话一直留在侧边栏。
    // 放在每轮扫描后统一扫一遍，自动合并、手动合并、已经合过（skipped=merged）都能收干净。
    try {
      const archivedNotes = await archiveMergedNotices({ dws, stateFile: cfg.stateFile, log })
      if (archivedNotes.length) out.cleanup = [...(out.cleanup ?? []), ...archivedNotes]
    } catch (e) {
      log(`归档通知会话失败：${e.message}`)
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
      const key = String(w.target)
      const side = sidebar?.[key]
      // 监听的主判据就是侧边栏的 running：
      // - 在跑 → 只记一笔，不读 status/info（这两个都要 goto，会一遍遍把用户窗口拽到这条会话上）；
      // - 没在跑、且这次收工已经处理过 → 直接跳过，一个字节都不读；
      // - 没在跑、还没处理过 → 收工这轮读一次 status 判结论，该通知就通知。
      // 侧边栏再把它报成 running 时才清掉 idle，等下一次收工。
      book.reload()
      const led = book.notified[key] ?? {}
      if (side?.running) {
        if (led.idle) book.clearIdle(key)
        if (led.gone) book.clearGone(key)
        rec.lastPhase = "running"
        rec.lastPollAt = nowIso()
        continue
      }
      // 侧边栏里根本没有这条（已归档/已收起）：只记 gone，不读 status。
      // status 切不过去，只会回「侧边栏里没有任务」，每轮刷一次日志、白拽一次窗口。
      if (sidebar && !side) {
        if (!led.gone) book.markGone(key)
        rec.lastPhase = "gone"
        rec.lastPollAt = nowIso()
        continue
      }
      // 又回到侧边栏里了：清 gone，这一轮重新判一次（中间可能又跑完过一轮）。
      if (side && led.gone) {
        book.clearGone(key)
      } else if (side && led.idle) {
        rec.lastPhase = "idle"
        rec.lastPollAt = nowIso()
        continue
      }
      // 收工处理完（无论通知了还是没什么可通知）就把这条落成 idle，下一轮只看 running。
      // 读不到侧边栏时（side 空的退化路径）不落：没有 running 可看，还得靠 status 兜着。
      const park = () => { if (side) new Book(cfg.stateFile).markIdle(key) }
      let status
      try {
        status = await dws.status(w.target)
      } catch (e) {
        state.dwsErrors++
        log(`dws status ${w.target} 失败：${e.message}`)
        continue
      }
      const prev = book.notified[key] ?? {}
      // 同一指纹最多尝试 maxAttempts 次：dws.send 会「消息到了却报发送失败」，
      // 不封顶就会每轮 poll 补发一次，把调用方会话刷成重复通知。
      const decision = judgePoll(prev, status, { maxAttempts: notifyMaxAttempts(cfg) })
      rec.lastPhase = decision.phase
      rec.lastFingerprint = decision.fingerprint
      rec.lastPollAt = nowIso()
      if (decision.phase === "finished" || decision.phase === "settled") out.settled++
      if (!decision.shouldNotify) {
        // status 说还在跑（侧边栏那一下是慢半拍）就别落 idle，下一轮再看。
        if (decision.phase !== "running") park()
        continue
      }

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
          await engine.emit("issue.concluded", { issueKey: w.issueKey, target: w.target, status: result.status, pr: result.pr ?? null, workflow: "own" })
          // 结论里带 PR 说明会话已经 push 并开好了 PR：推进到「出 PR」这一阶段。
          if (Number(result.pr)) {
            await engine.emit("pr.opened", {
              issueKey: w.issueKey,
              pr: Number(result.pr),
              prUrl: result.prUrl ?? "",
              target: w.target,
              workflow: "own",
            })
          }
        }
      }

      // 合并通道已取消：会话自己 push + 开 PR 之后就停在这里。
      // PR 合不合由编排会话核对工单后用 `foreman pr merge` 直接合，poll 不再入队、也不在这轮里合。
      const bookM = new Book(cfg.stateFile)
      let mergeQueued = false
      if (Number(result?.pr)) {
        const pr = Number(result.pr)
        const repo = w.repo || String(w.issueKey ?? "").split("#")[0]
        if (w.issueKey) bookM.setIssue(w.issueKey, { state: "pr-open", pr, prUrl: result.prUrl ?? "" })
        log(`PR ${repo}#${pr} 已开好，等编排核对后 foreman pr merge（不再排合并通道）`)
      }
      const resultOut = result ? { ...result, merged: false, mergeError: "", mergeQueued } : result

      // 合并与收尾都不在这一轮做：等编排会话核对后调 foreman pr merge；合完再清工作区、归档执行会话。
      const book2 = new Book(cfg.stateFile)
      const nd = notifyDecision({ cfg, watcher: w, book: book2, env: process.env, result: resultOut })

      // 通知节点被暂停：这一轮不落，也不记指纹，等继续后自然补一次（不影响别的节点）。
      if (ctx.engine?.paused?.("notify")) {
        log(`通知跳过 ${w.target}：通知节点已暂停`)
        continue
      }
      // 已经归档 / 已关单合并的执行会话：结论不必再推给编排会话——
      // 合并收尾时已经发过「合并完成」，这里再发一条只是重复。
      // 节点照样落一次痕（不走 engine.emit，避免把跳过也算成「执行了 1 次」）。
      const issKey = String(w.issueKey ?? "")
      const bookIss = new Book(cfg.stateFile)
      const iss = issKey ? bookIss.issue(issKey) : null
      const prOf = Number(iss?.pr ?? 0)
      const mergeKey = prOf ? `${w.repo || String(issKey).split("#")[0]}#${prOf}` : ""
      const merged = mergeKey && bookIss.mergeAsk?.[mergeKey]?.status === "merged"
      if (merged) {
        const payload = { issueKey: issKey, target: w.target, kind: "archived-skip", detail: "会话已归档，跳过通知" }
        book2.markNotified(w.target, decision.fingerprint, { phase: decision.phase, chars: status?.chars ?? 0 })
        if (engine.lifecycle && typeof engine.lifecycle.emit === "function") await engine.lifecycle.emit("notice.delivered", payload)
        else await engine.emit("notice.delivered", payload)
        log(`通知跳过 ${w.target}：工单已关单合并（会话已归档，不再通知编排会话）`)
        park()
        continue
      }

      // notify 节点保留，但节点里不再真的发通知：只落一次痕（指纹 + 节点事件 + 操作日志），
      // 不新建会话、不 dws.notify、也不跑续接催办——暂时不需要向谁通知。
      // 要恢复投递：从 git 历史（本提交之前）取回 deliver / dws.notify 与续接那一整段。
      const payload = {
        issueKey: issKey,
        target: "",
        kind: nd.send ? nd.event : "",
        detail: nd.send ? "通知已停用，未发送" : (nd.reason || "无需通知"),
      }
      book2.markNotified(w.target, decision.fingerprint, { phase: decision.phase, chars: status?.chars ?? 0 })
      rec.notifiedAt = nowIso()
      if (engine.lifecycle && typeof engine.lifecycle.emit === "function") await engine.lifecycle.emit("notice.delivered", payload)
      else await engine.emit("notice.delivered", payload)
      log(`通知跳过 ${w.target}：notify 节点只落痕（${decision.phase}/${payload.kind || "-"}）`)
      park()
    }
    // 合并助手交回的 RESULT 也在这轮收：判了可合就走 workflow 合并（runMergeTask）。
    // 复用上面读过的侧边栏，不再切一次窗口；判过的会话落 mergeJudge，不再反复读。
    try {
      out.verdict = await mergeVerdictOnce(ctx, { sidebar })
    } catch (e) {
      log(`合并判断失败：${e.message}`)
    }
    state.lastPollAt = nowIso()
    state.pollCount++
  } finally {
    state.polling = false
  }
  return out
}

// ---- 合并通道 ----

// runMergeTask：合并一条 PR 并收尾（关单、摘监听、清工作区、归档执行会话）。
// 结果只落账本 + 控制台：CLI 与合并判断的调用点都带 notify:false，不再新开「合并完成」会话。
// 合不了只记账不发脾气，也不 force merge。
// 合并 / 关单是两条流程共用的阶段，必须落到对应那条流程上，否则控制台会张冠李戴
// （自有工单的 PR 被记成「他人 PR」流程，run 停在 close，工单那条 own 永远卡在 pr-open）。
function workflowForIssue({ book, repo, issueNo = 0, declared = "" } = {}) {
  const wf = String(declared ?? "").trim()
  if (wf === "own" || wf === "review") return wf
  const issueKey = issueNo ? `${repo}#${Number(issueNo)}` : ""
  const rec = issueKey && book?.issue ? book.issue(issueKey) : null
  // 账本里有这张单的派活痕迹（分支/工作区/执行会话）→ 自有工单；否则是别人的 PR。
  if (rec && (rec.branch || rec.worktree || rec.agent)) return "own"
  return "review"
}

export async function runMergeTask(ctx, task = {}) {
  const { cfg, log = () => {} } = ctx
  const key = String(task.key ?? `${task.repo}#${task.pr}`)
  const repo = String(task.repo ?? "").trim()
  const pr = Number(task.pr ?? 0)
  const issueNo = Number(task.issue ?? 0) || 0
  if (!repo || !pr) return { ok: false, reason: "bad-task" }
  const style = String(task.style ?? cfg.merge?.style ?? "merge")
  const deleteBranch = task.deleteBranch !== false
  // 账本里已经是合并状态：不重复合，直接把队列条目收掉。
  const book0 = new Book(cfg.stateFile)
  // 一工程一工作区：跨工程的单，PR 在别的仓库、工单在哪个仓库只有账本的 prs[] 知道，
  // 所以先在账本里按 (repo, pr) 反查工单键，别拿 PR 自己的仓库硬拼。
  const plannedKey = issueKeyForPr(book0, repo, pr, issueNo)
  const plannedNo = Number(String(plannedKey).split("#")[1] ?? 0) || issueNo
  // 这条 PR / 这张单属于哪条流程：显式指定就用它；没指定时按账本推断。
  // foreman 派过的单一定有 branch / worktree / agent（own）；查不到痕迹的 PR 才是别人开的（review）。
  const workflow = workflowForIssue({
    book: book0,
    repo: String(plannedKey).split("#")[0] || repo,
    issueNo: plannedNo,
    declared: task.workflow,
  })

  if (book0.mergeAsk?.[key]?.status === "merged") {
    book0.markMergeTask(key, { status: "merged", detail: "账本里已是合并状态" })
    return { ok: true, skipped: "already-merged" }
  }

  const op = startOperation(ctx, "merge", `合并 PR ${repo}#${pr}`, {
    key,
    detail: `${style} · 并发 ${cfg.merge?.concurrency ?? 1} · 不 force merge`,
  })
  let alreadyMerged = false
  // 「他人 PR」流程：动手合之前先记一笔「核对完、决定合」。
  if (workflow === "review") {
    await ctx.engine?.emit("pr.reviewed", { key, pr, repo, target: task.target ?? "", workflow })
  }
  try {
    await ctx.gitea.mergePr(repo, pr, { style, deleteBranch })
  } catch (e) {
    const msg = String(e?.message ?? e ?? "")
    // 「已经合并」不算失败：opencli 对已合的 PR 回 EMPTY_RESULT + 提示无需重复合并。
    if (/无需重复合并|已经合并|已合并/.test(msg)) {
      alreadyMerged = true
      log(`${repo}#${pr} 已经是合并状态，按已合并收尾（${key}）`)
    } else {
      const reason = await mergeFailureReason({ gitea: ctx.gitea, repo, pr, error: e })
      const b = new Book(cfg.stateFile)
      b.markMergeAsked(key, { pr, url: task.url ?? "", status: "failed", error: reason })
      b.markMergeTask(key, { status: "failed", error: reason })
      log(`合并失败 ${repo}#${pr}：${reason}`)
      finishOperation(ctx, op, "failed", reason)
      // 失败也只记账：通知暂停期间不回执给任何人，负责合并的一方从控制台/账本看原因。
      return { ok: false, reason }
    }
  }

  // 合并成功：按 PR 反查它属于哪张工单。没传 --issue 时不再留空——留空的话 close 节点
  // 接不上，工单就停在 pr-open（PR #122 合完 #121 还挂着就是这个原因）。
  const book1 = new Book(cfg.stateFile)
  const resolvedKey = issueKeyForPr(book1, repo, pr, issueNo) || plannedKey
  const resolvedNo = Number(String(resolvedKey).split("#")[1] ?? 0) || 0
  const issueRepo = String(resolvedKey).split("#")[0] || repo
  const finalWorkflow = workflowForIssue({ book: book1, repo: issueRepo, issueNo: resolvedNo, declared: task.workflow })

  // 逐节点收尾：每个节点只清自己产生的东西。有 engine 时由它按节点跑
  // （merge → pr-open → dispatch → close → cleanup → archive）；没有 engine 时用同口径的 finishMergedPr。
  let done
  let cleanup = { notes: [] }
  if (ctx.engine) {
    const result = await ctx.engine.afterMerge({
      watcher: { issueKey: resolvedKey, target: task.target ?? "" },
      merge: { key, repo, pr, prUrl: String(task.url ?? ""), issueNumber: resolvedNo },
      book: book1,
      workflow: finalWorkflow,
    })
    done = { issueKey: resolvedKey, notes: result.notes ?? [] }
    cleanup = { notes: [], nodes: result.nodes ?? [] }
  } else {
    done = await finishMergedPr({
      gitea: ctx.gitea,
      cfg,
      log,
      stateFile: cfg.stateFile,
      repo,
      number: pr,
      issueNo: resolvedNo,
      issueKey: resolvedKey,
      url: String(task.url ?? ""),
      alreadyMerged,
      cleanup: async () => ({ notes: [] }),
    })
  }

  // 通知会话收尾：它报的 PR 现在都合完了，自动归档，别把「PR待合并」会话留在侧边栏。
  // 合完当场扫一遍（不等下一轮 PR 扫描）；归档失败只记 notes，不推翻合并事实。
  let archivedNotes = []
  try {
    archivedNotes = await archiveMergedNotices({ dws: ctx.dws, stateFile: cfg.stateFile, log })
  } catch (e) {
    log(`归档通知会话失败：${e.message}`)
  }
  const notes = [...(done.notes ?? []), ...(cleanup?.notes ?? []), ...archivedNotes]
  const book = new Book(cfg.stateFile)
  book.markMergeTask(key, { status: "merged", mergedAt: nowIso(), notes })
  ctx.consoleStore?.event({
    kind: "pr_merge", key, repo, number: pr,
    to: "merged", detail: `${style}${resolvedNo ? ` · 关单 #${resolvedNo}` : ""}${alreadyMerged ? " · 原本已合并" : ""}`,
  })
  try { ctx.consoleStore?.sync(new Book(cfg.stateFile)) } catch {}
  finishOperation(ctx, op, "success", `${alreadyMerged ? "原本已合并" : "合并成功"}${notes.length ? ` · ${notes.join("；")}` : ""}`)
  log(`合并通道：已合并 ${repo}#${pr}（${key}）${resolvedNo ? `，关单 #${resolvedNo}` : ""}`)
  // 合并成功不回执、不通知任何人：清理/归档已经做完，结果只落账本 + 控制台就收工。
  return { ok: true, alreadyMerged, notes }
}

// ---- 合并判断：合并助手交 RESULT → workflow 合并 ----
//
// 合并会话（deliver:merge，触发类型「PR待合并」）不再是执行者：它只判断可合性、
// 帮解冲突，然后把结论写成 RESULT 交回来。这里负责消费那份 RESULT：
// 判了可合就按串行链走 runMergeTask（与 CLI `foreman pr merge` 共用 ctx.mergeChain），
// 判不下来就记账 + 写控制台，等人处理，不自己拍。
//
// 为什么不塞进 pollOnce 的 watcher 循环：这类会话 notify:false，故意不进监听（它是编排者），
// 硬塞进去会跟「通知谁」的逻辑打架。这里只用侧边栏判 running，没在跑才读一次 info，
// 判过就落 book.mergeJudge 不再读——单实例下读 info 要把窗口切到那条会话。

const VERDICT_GRACE_MS = 60_000 // 刚投递的会话先别读：可能还没开始跑
const VERDICT_RETRY_MS = 120_000 // 没取到结论 / 合并失败，隔两分钟再试
const VERDICT_MAX_MERGE_ATTEMPTS = 2 // 判过可合的 PR 最多合两次（第二次兜 mergeNote 慢半拍）

// 待判断的合并会话：只认 deliver:merge + 触发类型「PR待合并」。
// 「合并完成」那类会话只是回执，不再触发一次合并。
export function verdictSessions(book) {
  const out = []
  for (const [name, s] of Object.entries(book?.sessions ?? {})) {
    if (String(s?.kind ?? "") !== "deliver:merge") continue
    if (String(s?.notice ?? "") !== "PR待合并") continue
    const convId = String(s?.convId ?? "").trim()
    if (!convId) continue
    out.push({
      name,
      convId,
      repo: String(s?.repo ?? "").trim(),
      // createdAt 才是投递时间（record() 每次都会刷 updatedAt），宽限期按它算。
      at: String(s?.createdAt ?? s?.updatedAt ?? ""),
    })
  }
  return out
}

// 一次判断最多交几条 PR：顶层一条，或 items 里的多条（逐条判定，mergeable=false 的剔掉）。
function verdictTasks(result = {}, fallbackRepo = "") {
  const list = []
  const seen = new Set()
  const push = (repo, pr, url) => {
    const r = String(repo ?? "").trim()
    const n = Number(pr) || 0
    if (!r || !n) return
    const key = `${r}#${n}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ key, repo: r, pr: n, url: String(url ?? "") })
  }
  if (Array.isArray(result.items) && result.items.length) {
    for (const it of result.items) push(it.repo || result.repo || fallbackRepo, it.pr, it.prUrl)
  } else {
    push(result.repo || fallbackRepo, result.pr, result.prUrl)
  }
  return list
}

// judgeMergeVerdict：把一条合并会话的 RESULT 翻成动作。纯函数，测试直接调。
// action：
//   wait  —— 还没交 RESULT（会话可能还在写），下一轮再看；
//   merge —— 可合，tasks 交给 workflow 合并；
//   done  —— 账本里已经合过了，只需要把这条会话标记收口；
//   hold  —— 不合（不可合 / 需要拍板），记账等人；
//   skip  —— 开关关了，不处理。
export function judgeMergeVerdict({ cfg, record = {}, result = {}, book } = {}) {
  const merge = cfg?.merge ?? {}
  if (merge.enabled !== true) return { action: "skip", reason: "disabled", tasks: [] }
  if (merge.verdictAutoMerge === false) return { action: "skip", reason: "verdict-auto-off", tasks: [] }
  const status = String(result?.status ?? "").trim()
  if (!status || status === "none") return { action: "wait", reason: "no-result", tasks: [] }

  const repo = String(result?.repo || record?.repo || "").trim()
  const all = verdictTasks({ ...result, repo }, repo)
  // 顶层说不合，或逐条标了 mergeable=false 的都不合。
  const tasks = all.filter((t) => {
    const item = (result.items ?? []).find(
      (i) => String(i.repo || repo) === t.repo && Number(i.pr) === t.pr,
    )
    return item ? item.mergeable !== false : result.mergeable !== false
  })

  if (status !== "done") {
    return {
      action: "hold",
      reason: status,
      question: String(result.question ?? ""),
      summary: String(result.summary ?? ""),
      tasks: [],
    }
  }
  // 判断是这条链路的全部意义：RESULT 没写 mergeable 就不合（不能拿「没表态」当「可以合」）。
  if (result.mergeable !== true) {
    return {
      action: "hold",
      reason: result.mergeable === false ? "not-mergeable" : "no-mergeable-verdict",
      summary: String(result.summary ?? ""),
      tasks: [],
    }
  }
  if (!tasks.length) return { action: "hold", reason: "no-pr", summary: String(result.summary ?? ""), tasks: [] }
  const open = tasks.filter((t) => book?.mergeAsk?.[t.key]?.status !== "merged")
  if (!open.length) return { action: "done", reason: "already-merged", tasks: [] }
  return { action: "merge", reason: "", tasks: open }
}

// runVerdictTasks：把可合的 PR 交给 workflow（runMergeTask）落地。
// 与 CLI 共用一条串行链：同一时刻不会并着合两条。
// 合并结果只落账本 + 控制台，不再回一条「合并完成」：合并助手交完 RESULT 就收工，
// 为一句回执新开一条会话没有意义（2026-11-12 17:00 那条空会话就是这么冒出来的）。
async function runVerdictTasks(ctx, { name = "", tasks = [], attempt = 1 } = {}) {
  const { cfg, log = () => {} } = ctx
  const ok = []
  const failed = []
  for (const t of tasks) {
    new Book(cfg.stateFile).markMergeJudge(name, {
      status: "merging", tasks, attempts: attempt, key: t.key, repo: t.repo, pr: t.pr,
    })
    // notify: false —— 合并是代码落的，结果落账本 + 控制台就够了。
    const run = () =>
      runMergeTask(ctx, { key: t.key, repo: t.repo, pr: t.pr, url: t.url ?? "", source: "verdict", notify: false })
    const prev = ctx.mergeChain ?? Promise.resolve()
    const mine = prev.then(run, run)
    ctx.mergeChain = mine.then(() => {}, () => {})
    let out = null
    try {
      out = await mine
    } catch (e) {
      out = { ok: false, reason: String(e?.message ?? e ?? "") }
    }
    if (out?.ok) ok.push(t.key)
    else failed.push({ key: t.key, reason: out?.reason ?? "未知原因" })
  }
  const b = new Book(cfg.stateFile)
  if (failed.length) {
    const reason = failed.map((f) => `${f.key}：${f.reason}`).join("；").slice(0, 300)
    b.markMergeJudge(name, { status: "merge-failed", tasks, attempts: attempt, reason })
    log(`合并判断 → workflow 合并失败（${name}）：${reason}`)
  } else {
    b.markMergeJudge(name, { status: "merged", tasks: [], attempts: attempt, reason: ok.join("、") })
    if (ok.length) log(`合并判断 → workflow 已合并：${ok.join("、")}（${name}）`)
  }
  return ok.length
}

// mergeJudgeStat：控制台/status 用的判断账统计。
export function mergeJudgeStat(book) {
  const stat = { pending: 0, merged: 0, held: 0, failed: 0, gone: 0, lastAt: "" }
  for (const c of verdictSessions(book)) {
    const st = String(book?.mergeJudge?.[c.name]?.status ?? "")
    if (st === "merged") stat.merged++
    else if (st === "held") stat.held++
    else if (st === "merge-failed") stat.failed++
    else if (st === "gone") stat.gone++
    else stat.pending++
    const at = String(book?.mergeJudge?.[c.name]?.at ?? "")
    if (at && at > stat.lastAt) stat.lastAt = at
  }
  return stat
}

// mergeVerdictOnce：一轮「读合并助手的结论 → 走 workflow 合并」。
// sidebar 传进来就复用（pollOnce 已经读过一次侧边栏），没传自己读一次。
export async function mergeVerdictOnce(ctx, { sidebar = null } = {}) {
  const { cfg, log = () => {} } = ctx
  const out = { checked: 0, merged: 0, held: 0, gone: 0, waiting: 0 }
  if (cfg?.merge?.enabled !== true) return out
  const book0 = new Book(cfg.stateFile)
  const cands = verdictSessions(book0)
  if (!cands.length) return out
  let side = sidebar
  if (!side && typeof ctx.dws?.runningMap === "function") {
    try {
      side = await ctx.dws.runningMap()
    } catch (e) {
      log(`合并判断本轮跳过：读不到侧边栏（${e.message}）`)
      return out
    }
  }
  for (const c of cands) {
    const led = new Book(cfg.stateFile).mergeJudge[c.name] ?? {}
    const st = String(led.status ?? "")
    // 终态：不再读这条会话。
    if (["merged", "gone", "held"].includes(st)) continue
    if (st === "merging") continue
    if (st === "merge-failed" && Number(led.attempts ?? 0) >= VERDICT_MAX_MERGE_ATTEMPTS) continue
    out.checked++
    // 刚投递：先别读，也不判「已收起」（会话可能还没出现在侧边栏）。
    const ageMs = Date.now() - Date.parse(c.at ?? "")
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < VERDICT_GRACE_MS) continue
    if (side?.[c.convId]?.running) continue
    if (side && !side[c.convId]) {
      new Book(cfg.stateFile).markMergeJudge(c.name, { status: "gone", reason: "会话已收起，结论没取到" })
      out.gone++
      log(`合并判断跳过 ${c.name}：会话已收起，没取到 RESULT`)
      continue
    }
    // 已判「可合」但合并失败：不重读会话，隔一会儿再合一次（兜 mergeNote 慢半拍）。
    if (st === "merge-failed") {
      const agoMs = Date.now() - Date.parse(led.at ?? "")
      if (Number.isFinite(agoMs) && agoMs >= 0 && agoMs < VERDICT_RETRY_MS) continue
      out.merged += await runVerdictTasks(ctx, {
        name: c.name, tasks: led.tasks ?? [], attempt: Number(led.attempts ?? 0) + 1,
      })
      continue
    }
    // 上一轮没读到结论：退避两分钟再读，避免每 20s 切一次用户窗口。
    if (st === "no-result") {
      const agoMs = Date.now() - Date.parse(led.at ?? "")
      if (Number.isFinite(agoMs) && agoMs >= 0 && agoMs < VERDICT_RETRY_MS) continue
    }

    let result = null
    try {
      const info = await ctx.dws.info(c.convId)
      const text = String(info?.lastReply ?? "")
      if (text) result = parseResult(text)
    } catch (e) {
      log(`读合并会话 ${c.name} 的结论失败：${e.message}`)
      // 记成 no-result：下一轮隔两分钟再读，别每 20s 就去切一次用户窗口。
      new Book(cfg.stateFile).markMergeJudge(c.name, { status: "no-result", reason: "info-failed" })
      continue
    }
    const d = judgeMergeVerdict({ cfg, record: c, result, book: new Book(cfg.stateFile) })
    if (d.action === "wait") {
      new Book(cfg.stateFile).markMergeJudge(c.name, { status: "no-result", reason: d.reason })
      out.waiting++
      continue
    }
    if (d.action === "skip") continue
    if (d.action === "done") {
      new Book(cfg.stateFile).markMergeJudge(c.name, { status: "merged", reason: d.reason, tasks: [] })
      out.merged++
      continue
    }
    if (d.action === "hold") {
      new Book(cfg.stateFile).markMergeJudge(c.name, {
        status: "held", reason: d.reason, question: d.question ?? "", summary: d.summary ?? "",
      })
      ctx.consoleStore?.event({
        kind: "pr_judge", key: c.name, repo: c.repo, number: d.tasks?.[0]?.pr ?? null,
        to: "held", detail: `不合：${d.reason}${d.question ? ` · ${d.question}` : ""}`,
      })
      out.held++
      log(`合并判断 ${c.name}：不合（${d.reason}）${d.question || d.summary ? ` · ${d.question || d.summary}` : ""}`)
      continue
    }
    // action=merge：判断到此为止，合并交给 workflow。
    out.merged += await runVerdictTasks(ctx, { name: c.name, tasks: d.tasks, attempt: 1 })
  }
  return out
}

// ---- 连接处理 ----

// ---- 请求分发 ----

// finishMergedPr：PR 合并成功后的收尾入口（没有 engine 的调用方也走这里）。
// 老实现把「落账 + 关单 + 摘监听 + 清工作区」挤在一处，任何一步漏掉都会留下别人的产物：
// PR 停在「已通知待合并」、执行会话监听还在听、worktree 与分支不清。现在按节点拆开，
// 每个节点只清自己产生的东西，这里只负责按顺序把它们叫起来：
//   merge（合并事实落账）→ close（关单 + 摘接单标签 + 工单 done）
//   → pr-open（PR 记 merged）→ dispatch（摘会话监听）→ workspace（关 herdr / 删 worktree / 删分支）
//   → cleanup（兜底清扫）
// opencli 对已经合并的 PR 会回 EMPTY_RESULT + 提示「无需重复合并」，字面当失败的话台账
// 还会卡成 merge-failed、再没人收尾，所以这里也接受 alreadyMerged=true。
export async function finishMergedPr({
  gitea,
  cfg = {},
  log = () => {},
  stateFile,
  repo,
  number,
  issueNo = 0,
  issueKey = "",
  url = "",
  alreadyMerged = false,
  cleanup = cleanupPrArtifacts,
} = {}) {
  const key = `${repo}#${number}`
  const book = new Book(stateFile)
  // 一工程一工作区：跨工程时 PR 的仓库不是工单的仓库，工单键必须由调用方给（或按 prs[] 反查）。
  const issueKeyResolved = issueKey || (issueNo ? issueKeyForPr(book, repo, number, issueNo) : "")
  const ctx = {
    book,
    cfg,
    repo,
    pr: number,
    prUrl: url,
    issueKey: issueKeyResolved,
    issueNo: Number(issueNo ?? 0),
    key,
    tracker: {
      closeIssue: (r, n) => gitea.closeIssue(r, n),
      editLabels: typeof gitea?.editLabels === "function" ? (r, n, o) => gitea.editLabels(r, n, o) : undefined,
    },
    session: null,
    workspace: { cleanup },
    log,
  }
  const notes = []
  for (const stage of ["merge", "close", "pr-open", "dispatch"]) {
    notes.push(...(await runNodeCleanup(stage, ctx)).notes)
  }
  // workspace 节点处置账本里的 worktree/分支；没有关联工单时它只回一句跳过说明。
  if (issueKeyResolved) notes.push(...(await runNodeCleanup("workspace", ctx)).notes)
  notes.push(...(await runNodeCleanup("cleanup", ctx)).notes)
  return { key, issueKey: issueKeyResolved, notes, alreadyMerged }
}

// cleanupPrArtifacts：合并后的本地收尾——删 worktree、删本地分支。
// 尽力而为：任何一步失败只记 notes，不反过来推翻「已经合并」。worktree 里有未提交改动
// 就保留（worktreeRemove 是 --force，先用 statusPorcelain 挡一道，别把别人的在写内容删掉）。
export async function cleanupPrArtifacts({ repoDir, worktree, branch = "" } = {}) {
  const notes = []
  if (!worktree) {
    notes.push("账本里没有 worktree 记录，跳过本地清理")
    return { notes }
  }
  if (!fs.existsSync(worktree)) {
    notes.push("worktree 已不在，跳过")
  } else {
    let dirty = ""
    try {
      dirty = await statusPorcelain(worktree)
    } catch {}
    if (dirty) notes.push("worktree 还有未提交改动，保留")
    else if (await worktreeRemove(repoDir, worktree)) notes.push("worktree 已删除")
    else notes.push("worktree 删除失败，保留")
  }
  if (branch && repoDir) {
    try {
      await git(["branch", "-d", branch], { cwd: repoDir })
      notes.push(`本地分支 ${branch} 已删`)
    } catch {
      notes.push(`本地分支 ${branch} 未删（未合并或已不存在）`)
    }
  }
  return { notes }
}

// archiveMergedNotices：一条「PR待合并」通知会话报过的 PR 全部合完后，自动把这条会话归档。
// 早先只有执行会话会在 pr.merged 上被归档，通知会话没人管：一条条留在侧边栏里、
// 既没人读也没人收（#235 与重复投递出的两条 #238 会话就是这么积下来的）。
// 只动 foreman 自己新建的投递会话（notices 账本里登记的），不碰执行会话与用户自己的会话。
export async function archiveMergedNotices({ dws, stateFile, log = () => {} } = {}) {
  const notes = []
  if (!dws || typeof dws.archive !== "function" || !stateFile) return notes
  const b = new Book(stateFile)
  for (const [target, info] of Object.entries(b.notices)) {
    const prs = Array.isArray(info?.prs) ? info.prs : []
    if (!prs.length) continue
    const allDone = prs.every((k) => {
      const rec = b.prSeen[k]
      return rec && (rec.merged === true || rec.skipped === "merged")
    })
    if (!allDone) continue
    const name = String(info?.name || target)
    try {
      await dws.archive(name)
      new Book(stateFile).delNotice(target)
      notes.push(`通知会话 ${name} 已归档`)
      log(`已归档通知会话（它报的 PR 都合完了）：${name}`)
    } catch (e) {
      const msg = String(e?.message ?? e ?? "")
      // 归档不成功不推翻合并事实：只记一笔，下一轮再试（notice 记录留着）。
      notes.push(`通知会话 ${name} 归档失败：${msg.slice(0, 120)}`)
      log(`归档通知会话 ${name} 失败：${msg}`)
    }
  }
  return notes
}

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
    const op = startOperation(ctx, "pr-open", `创建 PR ${repo}`, { key: repo, detail: `${base} ← ${head}` })
    try {
      pr = await ctx.gitea.createPr({ repo, base, head, title, body: String(req.body ?? "") })
    } catch (e) {
      finishOperation(ctx, op, "failed", e.message)
      return fail("gitea-error", e.message)
    }
    const number = Number(pr.number ?? 0)
    if (!number) {
      finishOperation(ctx, op, "failed", `PR 建了但拿不到编号：${pr.url ?? ""}`)
      return fail("no-pr-number", `PR 建了但拿不到编号：${pr.url ?? ""}`)
    }
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
    // 一工程一工作区：跨工程的单会在多个仓库各开一条 PR，账本按 <工单所在仓库>#<N> 记一组 prs[]。
    // 主仓库那条仍写 pr / prUrl / branch（控制台与老逻辑读这几个字段）。
    const issueRepo = String(req.issueRepo ?? "").trim() || repo
    if (issueNo) {
      const issueKey = `${issueRepo}#${issueNo}`
      const rec = b.issue(issueKey) ?? {}
      const patch = {
        state: rec.state === "done" ? "done" : "pr-open",
        prs: upsertPr(rec.prs, { repo, branch: head, pr: number, prUrl: pr.url ?? "" }),
      }
      if (repo === issueRepo || !Number(rec.pr ?? 0)) {
        patch.pr = number
        patch.prUrl = pr.url ?? ""
        patch.branch = head
      }
      b.setIssue(issueKey, patch)
    }
    ctx.consoleStore?.event({
      kind: "pr_open", key: `${repo}#${number}`, repo, number,
      to: "open",
      detail: `${base} ← ${head}${issueNo ? ` · 工单 ${issueRepo}#${issueNo}` : ""}`,
    })
    // 立刻落库，控制台不用等下一轮同步。
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    ctx.log?.(`PR 建好 ${repo}#${number} ${pr.url ?? ""}（走 foreman）`)
    finishOperation(ctx, op, "success", `${repo}#${number} · ${pr.url ?? ""}`)
    return ok({ repo, pr: number, url: pr.url ?? "", issue: issueNo || null, issueRepo: issueNo ? issueRepo : null })
  }

  // ws add：一工程一工作区。执行会话在跑的过程中发现还要改别的工程，就用这条现开一个工作区
  // （幂等：已有就复用），不必为了跨工程交 need_decision，也不许去主 checkout 里改。
  // 用法：foreman ws add --repo <工程名|owner/name> --issue <owner/name>#<工单号> [--base <基线>]
  if (cmd === "ws add") {
    const issueRef = String(req.issue ?? "").trim()
    const m = issueRef.match(/([^#\s]+)#([0-9]+)$/)
    if (!m) return fail("bad-request", `ws add 的 --issue 要写成 <owner/name>#<工单号>，收到：${issueRef || "（空）"}`)
    const key = `${m[1]}#${Number(m[2])}`
    const repoRef = String(req.repo ?? "").trim()
    const repoCfg = (ctx.cfg.repos ?? []).find((r) => r.repo === repoRef || r.name === repoRef)
    if (!repoCfg) return fail("bad-request", `配置里没有这个工程：${repoRef || "（空）"}`)
    const book0 = new Book(ctx.cfg.stateFile)
    const rec = book0.issue(key)
    if (!rec) return fail("bad-request", `没处理过这条工单：${key}（先核对 --issue 的仓库与单号）`)
    const prev = findWorkspace(rec, repoCfg.repo)
    const branch = prev?.branch || issueBranch({ number: Number(m[2]) }, rec.title ?? "")
    const base = String(req.base ?? "").trim() || repoCfg.base
    let wt
    try {
      wt = await createWorktree({
        repoDir: repoCfg.dir,
        worktreeDir: path.join(ctx.cfg.worktreeDir, repoCfg.name),
        branch,
        base,
        herdrBin: ctx.cfg.herdr?.bin ?? "herdr",
        useHerdr: ctx.cfg.herdr?.enabled !== false,
        log: ctx.log ?? (() => {}),
      })
    } catch (e) {
      return fail("workspace-failed", String(e?.message ?? e))
    }
    // 老账本（没有 workspaces）只有主仓库那条：先用工单键里的仓库把它补进清单，再加新工程，
    // 免得把主仓库的 worktree 记录冲掉、以后收尾找不到它。
    const keyRepo = String(m[1])
    const base0 = Array.isArray(rec.workspaces) && rec.workspaces.length
      ? rec.workspaces
      : (rec.worktree ? [{ repo: keyRepo, branch: rec.branch ?? "", worktree: rec.worktree }] : [])
    const workspaces = mergeWorkspace(base0, {
      repo: repoCfg.repo,
      name: repoCfg.name,
      branch,
      base,
      worktree: wt.path,
      backend: wt.backend,
      addedAt: nowIso(),
    })
    book0.setIssue(key, {
      workspaces,
      repo: rec.repo || keyRepo,
      // 主仓库那条老字段保持原样：没有才补，别让后加的工程覆盖掉。
      ...(rec.branch ? {} : { branch: prev?.branch || workspaces[0]?.branch || branch }),
      ...(rec.worktree ? {} : { worktree: workspaces[0]?.worktree || wt.path }),
    })
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    ctx.log?.(`ws add ${key}：${repoCfg.repo} → ${wt.path}（${branch}，${wt.reused ? "复用" : `新建·${wt.backend}`}）`)
    return ok({
      key,
      repo: repoCfg.repo,
      branch,
      base,
      worktree: wt.path,
      reused: !!wt.reused,
      workspaces: workspaces.map((w) => ({ repo: w.repo, branch: w.branch, worktree: w.worktree })),
    })
  }

  // ws list：这条工单现在有几个工作区（每个工程一个）。
  if (cmd === "ws list") {
    const issueRef = String(req.issue ?? "").trim()
    const m = issueRef.match(/([^#\s]+)#([0-9]+)$/)
    if (!m) return fail("bad-request", `ws list 的 --issue 要写成 <owner/name>#<工单号>，收到：${issueRef || "（空）"}`)
    const key = `${m[1]}#${Number(m[2])}`
    const rec = new Book(ctx.cfg.stateFile).issue(key)
    if (!rec) return fail("bad-request", `没处理过这条工单：${key}`)
    return ok({
      key,
      workspaces: (rec.workspaces ?? []).map((w) => ({ repo: w.repo, branch: w.branch, worktree: w.worktree })),
      prs: (rec.prs ?? []).map((p) => ({ repo: p.repo, pr: p.pr, prUrl: p.prUrl, branch: p.branch })),
    })
  }

  if (cmd === "pr merge") {
    const repo = String(req.repo ?? "").trim()
    const number = Number(req.number ?? 0)
    if (!repo || !number) return fail("bad-request", "pr merge 需要 repo / number")
    const style = String(req.style ?? ctx.cfg.merge?.style ?? "merge")
    const deleteBranch = req.deleteBranch !== undefined ? req.deleteBranch !== false : ctx.cfg.merge?.deleteBranch !== false
    const issueNo = Number(req.issue ?? 0)
    const key = `${repo}#${number}`
    // 合并通道已取消：合并直接执行，不排队、不再有独立并发槽。
    // 只用一条进程内的串行链兜住：两条同时进来也不会并着合（合并要写账本，不能并发）。
    // 不写死「他人 PR」：交给 runMergeTask 按账本推断（自有工单的 PR 要落在 own 流程）。
    const workflow = String(req.workflow ?? "").trim() || undefined
    const run = () =>
      runMergeTask(ctx, {
        key, repo, pr: number, issue: issueNo, url: String(req.url ?? ""),
        style, deleteBranch, source: "cli", notify: false, workflow,
      })
    let result
    try {
      const prev = ctx.mergeChain ?? Promise.resolve()
      const mine = prev.then(run, run)
      ctx.mergeChain = mine.then(() => {}, () => {})
      result = await mine
    } catch (e) {
      return fail("merge-failed", String(e?.message ?? e))
    }
    if (!result?.ok) return fail("merge-failed", result?.reason ?? "未知原因")
    // 合并成功后把账本里的待合并条目收掉，避免再合一遍。
    try { new Book(ctx.cfg.stateFile).dropMerge(key) } catch {}
    // 通知会话收尾：它报的 PR 现在都合完了，自动归档，别把会话留在侧边栏。
    const notes = [...(result.notes ?? [])]
    try { notes.push(...(await archiveMergedNotices({ dws: ctx.dws, stateFile: ctx.cfg.stateFile, log: ctx.log }))) } catch {}
    ctx.log?.(`已合并 ${repo}#${number}${issueNo ? `，关单 #${issueNo}` : ""}（走 foreman）${notes.length ? `；收尾：${notes.join("；")}` : ""}`)
    return ok({ repo, number, merged: true, alreadyMerged: !!result.alreadyMerged, issue: issueNo || null, cleanup: notes })
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
    await ctx.engine?.emit("issue.closed", {
      issueKey: `${repo}#${number}`,
      key: `${repo}#${number}`,
      issue: number,
      workflow: workflowForIssue({ book: new Book(ctx.cfg.stateFile), repo, issueNo: number, declared: req.workflow }),
    })
    ctx.consoleStore?.event({ kind: "issue_close", key: `${repo}#${number}`, repo, number, to: "done" })
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    return ok({ repo, number, closed: true })
  }

  // workflow 节点：查看 / 暂停 / 继续。节点级开关——只停这一个节点自己的自动动作，
  // 不停止整条 workflow（在跑的单、后面的节点照常走）。
  if (cmd === "workflow") {
    const action = String(req.action ?? "view").trim()
    if (action === "view") {
      return ok({
        workflows: ctx.engine?.workflows() ?? [],
        nodes: ctx.engine?.nodes() ?? [],
        active: {
          own: ctx.engine?.active?.("own")?.length ?? 0,
          review: ctx.engine?.active?.("review")?.length ?? 0,
          maxOwn: Number(ctx.cfg.pickup?.maxRunning) || 2,
        },
        runs: ctx.engine?.runs?.(20) ?? [],
      })
    }
    const stage = String(req.stage ?? "").trim()
    if (!stage) return fail("bad-request", "workflow 节点操作需要 stage")
    const known = (ctx.engine?.nodes() ?? []).find((n) => n.stage === stage)
    if (!known) return fail("bad-request", `没有这个节点：${stage}`)
    const paused = action === "pause" ? true : action === "resume" ? false : undefined
    if (paused === undefined) return fail("bad-request", `action 只能是 view / pause / resume，收到 ${action}`)
    try {
      const saved = ctx.engine.setPaused(stage, paused)
      ctx.log?.(`workflow 节点 ${stage} 已${saved.paused ? "暂停" : "继续"}`)
      return ok({ stage, paused: saved.paused, nodes: ctx.engine?.nodes() ?? [] })
    } catch (e) {
      return fail("workflow-error", e.message)
    }
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
        maxRunning: ctx.cfg.pickup?.maxRunning,
        inflight: inflightIssues(new Book(ctx.cfg.stateFile)).length,
        lastAt: ctx.state.pickup?.lastAt ?? null,
        count: ctx.state.pickup?.count ?? 0,
        running: ctx.state.pickup?.running === true,
        lastResult: ctx.state.pickup?.lastResult ?? null,
      },
      // 派单与合并都不再有独立通道：接单容量按 workflow 实例数，合并由 `foreman pr merge` 当场执行。
      lanes: {
        dispatch: {
          maxRunning: ctx.cfg.pickup?.maxRunning ?? null,
          inflight: inflightIssues(new Book(ctx.cfg.stateFile)).length,
          workflowActive: ctx.engine?.active?.("own")?.length ?? 0,
        },
      },
      merge: {
        // 合并通道已取消：只剩「还有几条待合并的 PR」，合不合由编排调 pr merge 决定。
        queued: Object.values(new Book(ctx.cfg.stateFile).mergeQueue ?? {}).filter((t) => String(t.status ?? "queued") === "queued").length,
        // 合并助手的判断账：还在判几条、已合几条、挂着几条（判不下来的人处理）。
        judge: mergeJudgeStat(new Book(ctx.cfg.stateFile)),
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
        // 两条流程（own 自有工单 / review 他人 PR）+ 节点（含暂停状态与累计执行次数）+ 在跑实例。
        workflows: ctx.engine?.workflows() ?? [],
        stages: ctx.engine?.stages() ?? [],
        nodes: ctx.engine?.nodes() ?? [],
        active: {
          own: ctx.engine?.active?.("own")?.length ?? 0,
          review: ctx.engine?.active?.("review")?.length ?? 0,
          maxOwn: Number(ctx.cfg.pickup?.maxRunning) || 2,
        },
        runs: ctx.engine?.runs?.(20) ?? [],
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
