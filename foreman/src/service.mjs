// 常驻服务：HTTP 单通道（RPC + 控制台）；按 pollSeconds 轮询 dws status，跑完才异步通知。
// 写账本一律 new Book(cfg.stateFile) 现读现写，不长期持有（run 也在写同一个 state.json）。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { nowIso, sleep, inWorkHours } from "./util.mjs"
import { Book } from "./book.mjs"
import { deliverPrompt, noticeSessionName, issueBranch } from "./prompts.mjs"
import { builtinPrompt } from "./builtin-prompts.mjs"
import { notifyTarget, shouldNotify, notifyText, runRound, acquireLock, releaseLock, bucketOf, CLOSED_STATES } from "./orchestrator.mjs"
import {
  cleanIssue,
  cleanableIssues,
  orchestratorInfo,
  orchestratorTarget,
  ownedIssueOrchestrator,
  sessionFlowEnabled,
  TERMINAL_ISSUE_STATES,
} from "./sessionflow.mjs"
import { enqueueTaskUpdate, deliverTaskUpdate } from "./taskevents.mjs"
import { findWorkspace, mergeWorkspace, upsertPr } from "./workspaces.mjs"
import { WorkflowEngine } from "./workflow/engine.mjs"
import { NODE_TEARDOWN, runNodeCleanup, resolveIssueKey, issueKeyForPr } from "./workflow/cleaners.mjs"
import { makeSessionAdapter } from "./workflow/adapters/session.mjs"
import { createChatWorkflow } from "./workflow/chat.mjs"
import { GiteaTrackerAdapter } from "./workflow/adapters/gitea.mjs"
import { prWatchOnce, prWatchTarget, mergeFailureReason, prNotifyText, shouldReport, ownedPrKeys, prKey, uiReviewers, uiReviewersReady, isOwnPr, isUiPrView } from "./prwatch.mjs"
import { pickupWatchOnce } from "./pickupwatch.mjs"
import { MailDriver, realRecipients } from "./mail.mjs"
import { acceptanceGate, detectUiChange, mailPollOnce, requestAcceptance, mailAcceptanceSent, mailAcceptanceFailed, deliverMailReply } from "./mailflow.mjs"
import { runningIssues, inflightIssues } from "./planner.mjs"
import { routerOnce } from "./core/router.mjs"
import { dreamOnce } from "./dreaming.mjs"
import { listPulls, viewPr, mergePr, closeIssue, createPr, commentIssue, viewIssue, createIssue, editIssue, READY_FOR_AGENT } from "./gitea.mjs"
import { ConsoleStore } from "./console.mjs"
import { InboxStore, AgentWorker, ScheduleRunner } from "./core/inbox.mjs"
import { OutboxStore, OutboxDispatcher } from "./core/outbox.mjs"
import { enqueueOutbound } from "./outbound.mjs"
import { LarkDriver } from "./lark.mjs"
import { listSchedules, applySchedules, createAgentSchedule, firstRunAt, customAgentSchedules, hydrateSchedules, scheduleDefinitions, saveScheduleSettings } from "./core/schedules.mjs"
import { DEFAULTS, agentScheduleCwd, normalizeFeishuSection, normalizeProducts, persistAgent, repoWorkDir } from "./config.mjs"
import { normalizeEventEnvelope } from "./core/schedule-events.mjs"
import { runConfiguredScript } from "./core/executors.mjs"
import { startOperation, finishOperation } from "./operations.mjs"
import { startConsoleHttp } from "./consolehttp.mjs"
import { fileURLToPath } from "node:url"
import { pingOnce, readPortFile, connectHost } from "./svclient.mjs"
import { worktreeRemove, statusPorcelain, git, createWorktree, runWorktreeHooks } from "./gitx.mjs"

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
  const book = new Book(cfg.stateFile)
  const laneName = lane === "merge" ? "merge" : "dispatch"
  const dc = deliverContextFor(cfg, repo || watcher?.repo || "")
  const fixed = readFixedPrompt(cfg, repo || watcher?.repo || "", { lane: laneName })
  // 只报当前在跑数；pickup.maxRunning 是定时巡检上限，不约束 agent 主动派单。
  const running = inflightIssues(book).length
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
    const out = await dws.openNew({ name, prompt, noWait, repo: repoWorkDir(cfg, repo || watcher?.repo || "") })
    const convId = String(out?.convId ?? "").trim()
    // notice 记触发类型：「PR待合并」会话核对后直接执行 foreman pr merge，不交 RESULT。
    // 「合并完成」那类会话只做汇报，不再触发一次合并。
    book.record(name, {
      convId, kind: `deliver:${laneName}`, notify: false, product: dc.product,
      parent: laneName === "merge" ? String(book.data.router?.convId ?? book.data.inspector?.convId ?? "") : "",
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
  // event 映射：跑完时用 dws.info 读最后回复并 parseResult。
  let event = "session-done"
  if (result && result.status) {
    event =
      result.status === "none" ? "session-done"
      : result.status === "done" ? "done"
      : result.status === "need_decision" ? "needs-human"
      : result.status === "blocked" ? "blocked"
      : "failed"
  }
  const text = updateTextFor({ watcher, book, result, event })

  if (notify.enabled === false) return { send: false, reason: "disabled", event, text }
  // new 模式每次都新建会话，不需要「发给谁」：目标为空不算不发，也不存在「发给自己」。
  const mode = deliveryMode(cfg)
  const target = String(watcher?.notifyTo ?? "").trim() || notifyTarget(notify, env)
  if (mode === "existing") {
    if (!target) return { send: false, target, reason: "no-target", event, text }
    if (target === watcher?.target || target === watcher?.name) {
      return { send: false, target, reason: "self", event, text }
    }
  }

  // 有工单引用且 event 不是 session-done 时，按事件过滤；session-done 不过滤。
  if (watcher?.issueKey && event !== "session-done" && !shouldNotify(notify, event)) {
    return { send: false, target, event, reason: "event-filtered", text }
  }
  return { send: true, target, event, reason: "", text }
}

// 没有 RESULT 时给编排保留最近的完整对话，而不是只留最后一句；不带思考过程，避免无关上下文膨胀。
export function conversationTail(messages, maxChars = 12000) {
  const rows = (Array.isArray(messages) ? messages : [])
    .map((m) => {
      const text = String(m?.text ?? "").trim()
      if (!text) return ""
      const role = String(m?.role ?? m?.from ?? "").trim()
      const name = role === "user" || role === "human" ? "用户"
        : role === "assistant" || role === "bot" || role === "ai" ? "执行会话"
        : role || "消息"
      return `${name}：\n${text}`
    })
    .filter(Boolean)
  const text = rows.join("\n\n")
  if (text.length <= maxChars) return text
  return `……（仅保留最后 ${maxChars} 字）\n${text.slice(-maxChars)}`
}

// 结论正文：编排会话读这一条就知道哪张单、什么结果、PR 与工作区。
// 老的 notify 与新会话中心的 steer 共用同一段文案，不再维护两份。
export function updateTextFor({ watcher = {}, book = {}, result = null, event = "" } = {}) {
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
    prs: Array.isArray(result?.prs) ? result.prs : [],
    tests: String(result?.tests ?? ""),
    // 没解析出 RESULT：优先贴最近多轮对话；老适配器只有 text 时仍保留最后回复兜底。
    conversation: result?.status === "none" ? String(result?.conversation ?? "").trim() : "",
    lastReply: result?.status === "none" ? String(result?.text ?? "").trim() : "",
  }
  return notifyText(issueLike, outLike)
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

// 监听参数一律从配置来：这里只提供 DEFAULTS 里的默认值，不再写死字面量。
export function servicePaths(cfg) {
  const http = cfg.service?.http ?? DEFAULTS.service.http
  return {
    pidFile: cfg.service.pidFile,
    logFile: cfg.service.logFile,
    portFile: http.portFile ?? `${path.dirname(cfg.service.pidFile)}/service.port`,
    port: Number(http.port ?? DEFAULTS.service.http.port),
    host: http.host || DEFAULTS.service.http.host,
    tokenFile: http.tokenFile ?? `${path.dirname(cfg.service.pidFile)}/console.token`,
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

/** 只要监听地址不是回环，外部来源就必须带 token；回环监听不生成 token。 */
function consoleTokenFor(paths) {
  if (LOOPBACK_HOSTS.has(String(paths.host ?? "").trim())) return ""
  fs.mkdirSync(path.dirname(paths.tokenFile), { recursive: true })
  try {
    const raw = fs.readFileSync(paths.tokenFile, "utf8").trim()
    if (raw) return raw
  } catch {}
  const token = crypto.randomBytes(24).toString("hex")
  fs.writeFileSync(paths.tokenFile, `${token}\n`, { mode: 0o600 })
  return token
}

/** 监听所有网卡时，把本机各网卡的入口列出来（tailscale 的 100.x 也在其中）。 */
function consoleLanUrls(host, port) {
  if (LOOPBACK_HOSTS.has(String(host ?? "").trim())) return []
  const urls = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== "IPv4" || item.internal) continue
      urls.push(`http://${item.address}:${port}/`)
    }
  }
  return urls
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
      routeIssue: ctx.routeIssue,
    })
    const dispatched = handled.filter((h) => h.state === "dispatched")
    // 会话中心：捞到的单先交给编排会话（handed），工作会话等编排调 dispatch 才开。
    // 这里只推「已接单」，session.dispatched 由 dispatch 那条 RPC 自己推。
    const handed = handled.filter((h) => h.state === "handed")
    const engine = ctx.engine ?? new WorkflowEngine({ cfg, session: ctx.dws, log })
    for (const h of [...dispatched, ...handed]) {
      const issueKey = `${h.repo}#${h.number}`
      await engine.emit("issue.picked", { issueKey, workflow: "own" })
    }
    for (const h of dispatched) {
      const issueKey = `${h.repo}#${h.number}`
      await engine.emit("session.dispatched", { issueKey, target: h.convId ?? h.agent ?? "", workflow: "own" })
    }
    state.pickup.lastAt = nowIso()
    state.pickup.count = (state.pickup.count ?? 0) + 1
    state.pickup.lastResult = {
      dispatched: dispatched.length,
      handed: handed.length,
      handled: handled.map((h) => `${h.repo}#${h.number}:${h.state}`),
    }
    if (handled.length) {
      log(
        `自动巡检：${handled.map((h) => `${h.repo}#${h.number} ${h.state}`).join("、")}（派出 ${dispatched.length} 条，交给编排 ${handed.length} 条）`
      )
    } else {
      log("自动巡检：队列里没有可接的活")
    }
    return { ok: true, dispatched: dispatched.length, handed: handed.length, handled: state.pickup.lastResult.handled }
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

// 自动接单已移除：收口后不再由代码补单，下一轮由router agent判断优先级和空余容量。
// 保留同名函数是为了兼容旧调用点；它只返回 false，不再创建定时器或调用 pickupOnce。
export function kickPickup() {
  return false
}

// 「待分配任务」列表：配置仓库里的**全部 open 工单**，只做账本去重；接单标签过滤只留给自动巡检。// gitea 列一遍要打三条命令，页面刷新会太吵：这里带 45s 缓存，refresh=true 才强拉。
const CANDIDATE_TTL_MS = 45_000
let candidateCache = { at: 0, payload: null }

export function forgetCandidates() {
  candidateCache = { at: 0, payload: null }
}

export async function candidatesOnce(ctx, { refresh = false } = {}) {
  const { cfg } = ctx
  const now = Date.now()
  if (!refresh && candidateCache.payload && now - candidateCache.at < CANDIDATE_TTL_MS) {
    return { ...candidateCache.payload, cached: true }
  }

  const book = new Book(cfg.stateFile)
  const base = String(cfg?.gitea?.baseUrl ?? "http://106.54.199.229:3000").replace(/\/+$/, "")
  const items = []
  const errors = []

  for (const repoCfg of cfg.repos ?? []) {
    let list = []
    try {
      // 手动接单列的是**全部 open 工单**，不看接单标签：标签过滤只留给自动巡检。
      // needs-info 这类单也列出来，点接单时换决策提示词（见 pickIssue）。
      list = await ctx.gitea.listIssues(repoCfg.repo, {})
    } catch (e) {
      errors.push({ repo: repoCfg.repo, message: e.message })
      continue
    }
    // 只做账本去重，不做标签过滤：已处理 / 已交编排 / 在飞 / 试到上限的不再列。
    const pool = list.filter((it) => {
      if (!it?.number) return false
      const rec = book.issue(`${repoCfg.repo}#${it.number}`)
      if (!rec) return true
      if (CLOSED_STATES.has(rec.state)) return false
      if (rec.state === "handed") return false
      if (rec.state === "working" && !rec.lastFailure) return false
      if (rec.state === "working" && (rec.attempts ?? 0) >= (cfg.maxAttempts ?? 3)) return false
      return true
    })
    for (const it of pool) {
      items.push({
        repo: repoCfg.repo,
        name: repoCfg.name,
        number: it.number,
        title: it.title || "",
        url: it.url || `${base}/${repoCfg.repo}/issues/${it.number}`,
        labels: it.labels ?? [],
        assignees: it.assignees ?? [],
        author: it.author || "",
        bucket: bucketOf(it, cfg.pickup?.me),
        createdAt: it.createdAt || "",
      })
    }
  }

  // 页面只给 10 条：先按归属（我的 → 无人认领 → 他人认领），同档里再按创建时间，老的在前。
  // total 保留全量条数，让页面能提示「还有几条没显示」。
  const RANK = { mine: 0, unassigned: 1, others: 2 }
  items.sort(
    (a, b) =>
      (RANK[a.bucket] ?? 3) - (RANK[b.bucket] ?? 3) ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      a.number - b.number
  )
  const total = items.length
  const view = items.slice(0, 10)

  const runningOwn = ctx.engine?.active?.("own")?.length ?? 0
  const inflight = Math.max(inflightIssues(book).length, runningOwn)
  const payload = {
    ok: true,
    at: nowIso(),
    items: view,
    total,
    errors,
    capacity: { inflight, maxRunning: Number(cfg.pickup?.maxRunning) || 2 },
    // 候选处理只剩显式调用；auto 固定为 false，避免旧配置让状态页误以为仍在自动接单。
    pickup: { auto: false, legacyAutoConfigured: cfg.pickup?.auto === true, inWorkHours: inWorkHours(cfg) },
  }
  candidateCache = { at: now, payload }
  return { ...payload, cached: false }
}

// 一切需要 agent 的请求统一投 router 会话：router 是服务唯一主动维护的 agent 会话，
// 服务进程自己不再直接开任何别的 agent 会话（noop 载体下 router 会话也是假的，事件只入箱堆积）。
async function routeToRouter(ctx, { type, text, json }) {
  const notify = ctx.notifyRouter
  if (typeof notify !== "function") throw new Error("ctx.notifyRouter 未初始化，无法投递 router（命令需要在服务里跑）")
  const out = await notify({ type, text, json })
  if (out?.ok === false) throw new Error(String(out?.error || "router 投递失败"))
  return out
}

// 派单请求：账本记 handed（占槽，容量纪律照旧），事件投 router，由它作为唯一编排者接手。
// 不建任何编排/工作会话——router 消费事件后在会话内用内部 sub agent 完成编码与审查。
async function routeIssueToRouter(ctx, { repoCfg, issue, via = "hand" }) {
  const { log = () => {} } = ctx
  const key = `${repoCfg.repo}#${issue.number}`
  const book = new Book(ctx.cfg.stateFile)
  const prev = book.issue(key)
  if (prev) {
    if (CLOSED_STATES.has(prev.state)) return { ok: false, error: "already-handled", message: `${key} 已经处理过（${prev.state}），不重复派` }
    if (prev.state === "handed") return { ok: false, error: "already-handed", message: `${key} 已投给 router，等它接手` }
    if (prev.state === "working" && !prev.lastFailure) return { ok: false, error: "running", message: `${key} 正在跑，先看它的会话` }
  }
  const text = [
    `【Foreman · 接单】工单 ${key}「${issue.title ?? ""}」`,
    issue.url ? `链接：${issue.url}` : "",
    "你是这张单的唯一编排者：核对容量与工单内容后自行开工——在会话内创建编码与对抗审查内部 sub agent，",
    "编码侧用 foreman ws add / foreman pr open；需要决策时自行调研或邮件请人，不要把工单再派给别的会话。",
  ].filter(Boolean).join("\n")
  await routeToRouter(ctx, {
    type: "issue.hand",
    text,
    json: { issue: { key, repo: repoCfg.repo, number: issue.number, title: issue.title ?? "", url: issue.url ?? "", labels: issue.labels ?? [] } },
  })
  book.setIssue(key, {
    state: "handed",
    issue: issue.number,
    title: issue.title ?? "",
    url: issue.url ?? "",
    repo: repoCfg.repo,
    handedAt: nowIso(),
    handedVia: via,
  })
  await ctx.engine?.emit("issue.picked", { issueKey: key, workflow: "own" })
  log(`接单 ${key}：已投 router（${via}）`)
  return { ok: true, state: "handed", routed: "router", key }
}

// 控制台手动接单：只派点中的这一条，不看自动接单开关与工作时间；
// 查重、run.lock、节点暂停照旧守着，避免和 CLI / 自动巡检把同一张单派两遍。
export async function pickIssue(ctx, { repo = "", number = 0 } = {}) {
  const { cfg, log = () => {} } = ctx
  const repoCfg = findRepoCfg(cfg, String(repo ?? "").trim())
  if (!repoCfg) return { ok: false, error: "unknown-repo", message: `配置里没有这个工程：${repo || "（空）"}` }
  const n = Number(number) || 0
  if (!n) return { ok: false, error: "bad-request", message: "缺工单号" }

  const key = `${repoCfg.repo}#${n}`
  const book = new Book(cfg.stateFile)
  const prev = book.issue(key)
  if (prev) {
    if (CLOSED_STATES.has(prev.state)) {
      return { ok: false, error: "already-handled", message: `${key} 已经处理过（${prev.state}），不重复派` }
    }
    if (prev.state === "handed") {
      return { ok: false, error: "already-handed", message: `${key} 已交给编排会话，等它 dispatch` }
    }
    if (prev.state === "working" && !prev.lastFailure) {
      return { ok: false, error: "running", message: `${key} 正在跑，先看它的会话` }
    }
  }
  if (ctx.engine?.paused?.("pickup")) {
    return { ok: false, error: "node-paused", message: "接单节点已暂停，先在控制台把它继续" }
  }

  // 和 CLI / 自动巡检抢同一把锁：两边同时捞会把同一条单派两次。
  const lockFile = path.join(path.dirname(cfg.stateFile), "run.lock")
  const lock = acquireLock(lockFile)
  if (!lock) return { ok: false, error: "locked", message: "另一轮派单正在跑（run.lock），等它结束再点" }

  const op = startOperation(ctx, "dispatch", `手动接单 ${key}`, { key, detail: "控制台「待分配任务」点接单" })
  try {
    let issue
    try {
      issue = await ctx.gitea.viewIssue(repoCfg.repo, n)
    } catch (e) {
      finishOperation(ctx, op, "failed", e.message)
      return { ok: false, error: "gitea-error", message: `读不到工单 ${key}：${e.message}` }
    }
    issue.number = n

    // 带「需要人参与 / 信息不足」类标签的单：不按「改完 commit」派，换决策提示词让 agent 自己判断，
    const labels = (issue.labels ?? []).map((l) => String(l).toLowerCase())
    const exclude = new Set((cfg.pickup?.excludeLabels ?? []).map((l) => String(l).toLowerCase()))
    const decision = labels.some((l) => exclude.has(l))

    // 决策单走 Inbox：写 router.notice（type=issue.decision），由 Worker 串行 steer router agent，
    // router 消费后自行调研决策。派单请求一律走 Inbox 持久化 + Worker 串行投递，重启不丢。
    if (decision) {
      const notify = ctx.notifyRouter ?? ctx.notifyInspector
      if (typeof notify !== "function") {
        finishOperation(ctx, op, "failed", "ctx.notifyRouter 未初始化，无法写入决策单 Inbox")
        return { ok: false, error: "inbox-unavailable", message: "决策单需要 router Inbox 通道，但当前 ctx 没有 notifyRouter" }
      }
      const decisionLabels = labels.filter((l) => exclude.has(l)).join(", ")
      const text = [
        "【Foreman · router agent · 决策单待处理】",
        `工单 ${key}「${issue.title ?? ""}」带 ${decisionLabels} 标签，需先调研 + 决策，不直接编码。`,
        issue.url ? `链接：${issue.url}` : "",
        "请自行调研并给出结论：该切 ready-for-agent 就改标签，该交人就改 ready-for-human 或 foreman send --type mail 请用户决策；不要派编码，也不要把决策单当成可编码工单。",
      ].filter(Boolean).join("\n")
      let enqueueOut
      try {
        enqueueOut = await notify({
          type: "issue.decision",
          text,
          json: { issue: { key, repo: repoCfg.repo, number: n, title: issue.title ?? "", url: issue.url ?? "", labels: issue.labels ?? [] } },
        })
      } catch (e) {
        finishOperation(ctx, op, "failed", `决策单写 Inbox 失败：${e.message}`)
        return { ok: false, error: "inbox-failed", message: e.message }
      }
      if (enqueueOut?.ok === false || enqueueOut?.skipped) {
        const msg = enqueueOut?.error || enqueueOut?.skipped || "决策单写 Inbox 失败"
        finishOperation(ctx, op, "failed", msg)
        return { ok: false, error: "inbox-failed", message: msg }
      }
      // 账本先记 planned：等 router 派 decide 后才转 working，避免控制台提前看到「正在跑」。
      book.setIssue(key, {
        state: "planned",
        issue: n,
        title: issue.title ?? "",
        url: issue.url ?? "",
        repo: repoCfg.repo,
        decision: true,
      })
      await ctx.engine?.emit("issue.picked", { issueKey: key, workflow: "own" })
      finishOperation(ctx, op, "success", `决策单 · 已写入 router Inbox · event ${enqueueOut?.eventId ?? ""}`)
      try {
        ctx.consoleStore?.sync(new Book(cfg.stateFile))
        forgetCandidates()
      } catch {}
      log(`手动接单 ${key}：决策单已写入 router Inbox（event ${enqueueOut?.eventId ?? ""}）`)
      return { ok: true, decision: true, state: "inbox", eventId: enqueueOut?.eventId ?? "", convId: "" }
    }

    let out
    try {
      out = await routeIssueToRouter(ctx, { repoCfg, issue, via: "pickup" })
    } catch (e) {
      finishOperation(ctx, op, "failed", e.message)
      return { ok: false, error: "route-failed", message: e.message }
    }
    if (out.ok === false) {
      finishOperation(ctx, op, "failed", out.message || out.error)
      return out
    }
    finishOperation(ctx, op, "success", "已投 router")
    try {
      ctx.consoleStore?.sync(new Book(cfg.stateFile))
      forgetCandidates()
    } catch {}
    log(`手动接单 ${key}：已投 router`)
    return { ok: true, decision: false, ...out }
  } finally {
    releaseLock(lockFile)
  }
}


// 起服务：HTTP 单通道（CLI 的 RPC + 控制台页面同一个端口），端口写到文件里给 CLI 读。
// book 参数只用于初始加载，poll/write 时一律 new Book 重开。
// gitea 只在 PR 监听里用，测试可直接注入假的 { listPulls }。
export async function startServer({ cfg, book: _book, dws, log = () => {}, gitea = { listPulls, viewPr, mergePr, closeIssue, createPr, commentIssue, viewIssue, createIssue, editIssue }, mail = null }) {
  const paths = servicePaths(cfg)
  fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true })
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true })
  fs.mkdirSync(path.dirname(paths.portFile), { recursive: true })

  // 单实例：端口文件里的端口 ping 得通，说明已经有一个在跑。
  const existing = readPortFile(paths.portFile)
  if (existing) {
    try {
      await pingOnce({ host: connectHost(paths.host), port: existing }, 250)
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
    lastPollResult: null,
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
    // router agent 巡检运行时（持久会话与成功投递时间在 Book.router）
    router: { lastAt: null, count: 0, lastResult: null, running: false, nextAt: "" },
    routerInterval: null,
    dreaming: { lastAt: null, count: 0, lastResult: null, running: false, nextAt: "" },
    // 自定义 Agent 定时任务运行时：id -> { lastAt, count, lastResult, running, nextAt }
    agentSchedules: {},
    // 验收邮件轮询运行时
    mail: { lastPollAt: null, pollCount: 0, polling: false, lastResult: null, nextAt: "" },
    mailInterval: null,
    mailKick: null,
    // 合并通道运行时（与派单通道分开：各排各的队，各用各的并发）
    merge: { lastSweepAt: null, sweeps: 0, lastResult: null, interval: null, kick: null },
  }

  // 初始把 book 里的监听灌进内存。
  {
    const b = new Book(cfg.stateFile)
    for (const w of watchersFor(b, cfg)) state.watchers.set(String(w.target), { ...w })
  }

  // 通用 workflow：生命周期 + 适配器。ctx.dws / ctx.gitea 现在是**适配器**（旧调用面保留）。
  // agent 相关的一切（单实例护栏、读状态、归档）都收在适配器里：dws = 豆包，zcode = ZCode CLI，noop = 不碰任何前端。
  const engine = new WorkflowEngine({
    cfg,
    session: makeSessionAdapter(cfg, { driver: dws, log }),
    tracker: new GiteaTrackerAdapter({ impl: gitea }),
    log,
  })
  const ctx = { state, cfg, dws: engine.session, gitea: engine.tracker, engine, log, close: null, prPoll: null, httpUrl: "", consoleStore: null }
  // 执行载体查看/热切换（控制台 UI 用）：写回配置文件 + 当场换 session 适配器，不用重启服务。
  // 适配器有三个引用处要一起换：engine.session、lifecycle.adapters.session、ctx.dws（其余消费方
  // 都在调用时现读 ctx.dws，不存在闭包捕获）。旧载体还有在跑的会话时默认拒绝——切走后旧会话
  // 不再被监控（watch 会报 gone）；确认要弃就带 force。
  ctx.getAgent = () => ({
    agent: String(cfg.agent ?? "noop").trim().toLowerCase(),
    allowed: ["noop", "dws", "zcode"],
  })
  ctx.setAgent = async (next, { force = false } = {}) => {
    const v = String(next ?? "").trim().toLowerCase()
    if (!["noop", "dws", "zcode"].includes(v)) {
      throw Object.assign(new Error(`未知载体：${next}（可选 noop | dws | zcode）`), { code: "bad_agent" })
    }
    const current = String(cfg.agent ?? "noop").trim().toLowerCase()
    if (v === current) return { ok: true, agent: current, changed: false }
    let running = 0
    try {
      const map = await ctx.dws.runningMap()
      running = Object.values(map ?? {}).filter((s) => s?.running === true).length
    } catch {}
    if (running > 0 && !force) {
      throw Object.assign(new Error(`旧载体还有 ${running} 个在跑的会话，切走后不再被监控；确认弃单请用强切`), { code: "agent_busy", running })
    }
    const file = persistAgent(cfg, v)
    cfg.agent = v
    const session = makeSessionAdapter(cfg, { driver: dws, log })
    engine.session = session
    if (engine.lifecycle?.adapters) engine.lifecycle.adapters.session = session
    ctx.dws = session
    log(`agent 载体切换：${current} → ${v}（配置写进 ${file}${running > 0 ? `；${running} 个旧会话不再被监控` : ""}）`)
    return { ok: true, agent: v, previous: current, changed: true, runningLeft: running }
  }
  // 合并通道已取消：合并不再排独立的 lane/定时任务，`foreman pr merge` 直接执行，
  // 用一条进程内的串行链（ctx.mergeChain）兜住并发，账本照样写。
  // 投递通道：new 模式每次新建会话；这里只做一次绑定，调用侧不用关心实现。
  ctx.deliver = (opts) => deliverNewSession(ctx, opts)
  // 验收邮件：驱动一次绑定；验收回复注回会话、通过后合并都走这两个绑定，
  // 邮件模块不反向 import service（避免循环依赖）。
  ctx.mail = mail ?? new MailDriver({ bin: cfg.mail?.bin ?? "agently-cli", confirmed: cfg.mail?.confirmed !== false, log })
  // 验收邮件自动合并也走同一条串行链：和 CLI 的 `pr merge` 不并着合（合并要写账本）。
  ctx.merge = (task) => {
    const prev = ctx.mergeChain ?? Promise.resolve()
    const mine = prev.then(() => runMergeTask(ctx, task), () => runMergeTask(ctx, task))
    ctx.mergeChain = mine.then(() => {}, () => {})
    return mine
  }
  ctx.mailPoll = (opts) => mailPollOnce(ctx, opts)

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
  const inbox = new InboxStore(consoleStore.db)
  ctx.inbox = inbox
  ctx.chat = createChatWorkflow(ctx)
  // SQLite 是定时任务唯一事实源；旧 config.json 只在首次初始化时补迁移默认值。
  hydrateSchedules(cfg, inbox)
  // workflow 里的清理、归档也走同一本操作日志。
  engine.consoleStore = consoleStore
  engine.session.consoleStore = consoleStore
  // 前端走 Vite 构建产物（console/dist）；源码在 console/，改完跑 npm run build:console。
  const consoleDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "console", "dist")

  // 监听地址全部来自配置：host 不是回环时，控制台用 token 挡住外部来源。
  const consoleToken = consoleTokenFor(paths)
  let consoleHttp
  try {
    consoleHttp = await startConsoleHttp({
      store: consoleStore,
      ctx,
      dir: consoleDir,
      host: paths.host,
      port: paths.port,
      token: consoleToken,
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

  const lanUrls = consoleLanUrls(paths.host, port)
  // 端口文件（纯数字一行，CLI 直接读）+ pidfile（带上端口，便于排查）。
  fs.writeFileSync(paths.portFile, `${port}\n`)
  fs.writeFileSync(
    paths.pidFile,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        http: ctx.httpUrl,
        lanUrls,
        tokenFile: consoleToken ? paths.tokenFile : "",
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
  if (lanUrls.length) log(`监听 ${paths.host}，局域网/tailscale 入口：${lanUrls.join("  ")}`)
  if (consoleToken && lanUrls.length) log(`控制台 token：${paths.tokenFile}（外部访问需带 ?token= 或 x-foreman-token 头）`)

  // 执行收工由 router Schedule 每 1 分钟直接运行这段代码，也保留手动轮询入口。
  const doPoll = async () => pollOnce(ctx)

  const doPrPoll = async () => prPollOnce(ctx)
  ctx.prPoll = doPrPoll
  const doPickup = async (opts = {}) => pickupOnce(ctx, opts)
  ctx.pickup = doPickup
  let worker
  let scheduler
  const enqueueRouter = (notice = "") => {
    const envelope = normalizeEventEnvelope(typeof notice === "object" && notice !== null
      ? notice
      : { type: "router.notice", text: String(notice ?? "") })
    const book = new Book(cfg.stateFile)
    const convId = String(book.data.router?.convId ?? book.data.inspector?.convId ?? "")
    if (!envelope) return { ok: true, skipped: "empty", action: "none", convId }
    const text = envelope.text || JSON.stringify(envelope.json)
    const dedupeKey = `router:notice:${crypto.createHash("sha256").update(JSON.stringify(envelope)).digest("hex")}`
    const event = inbox.enqueue({ kind: "router.notice", text, payload: envelope, dedupeKey })
    return {
      ok: true, action: "inbox", eventId: event.id, status: event.status,
      type: envelope.type, convId,
    }
  }
  // 手动 route 才调用 Agent；10 分钟 Schedule 走下面的 pollOnce 脚本。
  const doRouter = async () => routerOnce(ctx, { force: true, scheduled: true })
  ctx.router = doRouter
  ctx.inspector = ctx.router // 旧 RPC 兼容；公开名称统一为 router agent。
  // PR 候选只持久化到 Inbox；Worker 负责合并、投递、失败重试，扫描器不直接调用 Agent。
  ctx.notifyRouter = async (text) => enqueueRouter(text)
  ctx.notifyInspector = ctx.notifyRouter
  // 验收邮件轮询：读收件箱，按主题里的 [FM-…] 把回复认回 PR 并注回会话。
  // 回复可能在半夜到，所以这条定时器**不受工作时间窗限制**（只读收件箱，不打扰谁）。
  const recordMailPoll = async (run) => {
    if (state.mail.polling) return { ok: true, skipped: "busy" }
    state.mail.polling = true
    try {
      const r = await run()
      if (r?.ok !== false) {
        state.mail.lastPollAt = nowIso()
        state.mail.pollCount++
        state.mail.lastResult = `查 ${r.checked ?? 0} 封 · 认回 ${r.matched ?? 0} · 判定 ${r.verdicts ?? 0} · 合并 ${r.merged ?? 0}`
        if (r.matched || r.reminders) log(`验收邮件：${state.mail.lastResult}${r.reminders ? ` · 催办 ${r.reminders}` : ""}`)
      }
      return r
    } finally {
      state.mail.polling = false
    }
  }
  const doMailPoll = async () => recordMailPoll(() => mailPollOnce(ctx))
  ctx.mailPollNow = doMailPoll
  // 控制台「待分配任务」：列候选（只读，带 45s 缓存）与手动接单（只派点中的那一条）。
  ctx.candidates = (opts) => candidatesOnce(ctx, opts)
  ctx.pickIssue = (args) => pickIssue(ctx, args)
  ctx.routeIssue = (args) => routeIssueToRouter(ctx, args)
  // 页面上的「立即执行」：不看开关和 cron 现在是什么状态，立刻跑一轮这类任务。
  // 只 bypass「没开 / 不在工作时间」；容量、busy、锁、节点暂停这些保护仍然生效。
  ctx.runSchedule = async (id) => {
    if (["pickup", "prWatch", "mail", "router", "inspector", "dreaming"].includes(id)) return scheduler.runNow(id === "inspector" ? "router" : id)
    if (customAgentSchedules(cfg).some((item) => item.id === id)) return scheduler.runNow(id)
    throw Object.assign(new Error(`${id} 没有可以立即执行的动作`), { code: "schedule_not_runnable" })
  }
  // 合并不再有定时任务（合并通道已取消）：`foreman pr merge` 当场执行，合完直接返回。

  // Outbox 与 Inbox 同库不同表：业务只写外发意图，单 Dispatcher 串行调用 mail/lark adapter。
  const outbox = new OutboxStore(consoleStore.db)
  ctx.outbox = outbox
  const larkDriver = new LarkDriver({ bin: cfg.lark?.bin ?? "lark-cli", as: cfg.lark?.as ?? "user" })
  const dispatcher = new OutboxDispatcher({
    store: outbox,
    log,
    pollMs: Number(cfg.outbox?.pollMs ?? 1000),
    retryMs: Number(cfg.outbox?.retrySeconds ?? 30) * 1000,
    leaseMs: Number(cfg.outbox?.leaseSeconds ?? 120) * 1000,
    handlers: {
      mail: (event) => ctx.mail.send(event.payload),
      lark: (event) => larkDriver.send({ ...event.payload, idempotencyKey: `fm-${event.uuid}` }),
      // feishu 渠道：入站同一个 app 的 SDK client 直发（lark 渠道是 lark-cli 的另一个 app，
      // open_id/chat 成员关系都跨不过去——飞书回复推送必须走这个渠道）。
      feishu: (event) => {
        const gw = ctx.feishu
        if (!gw || typeof gw.sendOutbound !== "function") throw new Error("飞书通道未启用（feishu.enabled=false 或启动失败），feishu 渠道不可外发")
        return gw.sendOutbound(event.payload)
      },
    },
    onSent: (event) => mailAcceptanceSent(ctx, event),
    onFailed: (event, error) => mailAcceptanceFailed(ctx, event, error),
  })
  ctx.outboxDispatcher = dispatcher
  outbox.onChange = () => dispatcher.wake()

  // Worker 先按结构化事件的 type 直处理；无法识别时交 router agent 判断。
  worker = new AgentWorker({
    store: inbox,
    log,
    pollMs: Number(cfg.inbox?.pollMs ?? 1000),
    retryMs: Number(cfg.inbox?.retrySeconds ?? 30) * 1000,
    leaseMs: Number(cfg.inbox?.leaseSeconds ?? 900) * 1000,
    handlers: {
      // 兼容旧的定时 router 事件；新定时轮询由 Schedule 的 script 执行器运行 pollOnce。
      router: ({ scheduled, notices }) => routerOnce(ctx, { force: true, scheduled, notices }),
      "chat.message": (batch) => ctx.chat.deliver(batch),
      "mail.reply": (event) => deliverMailReply(ctx, event),
      // 他人 PR 合并：扫描只写 pr.merge 事件，这里只把请求转投 router（不再建合并助手会话）。
      "pr.merge": async (batch) => {
        const delivered = []
        for (const event of batch) delivered.push(await deliverMergeCandidate(ctx, event))
        return delivered
      },
      "task.update": async (batch) => {
        const delivered = []
        for (const event of batch) delivered.push(await deliverTaskUpdate(ctx, event))
        return delivered
      },
    },
  })
  ctx.inboxWorker = worker
  inbox.onChange = () => worker.wake()
  const recordDream = async () => {
    if (state.dreaming.running) return { ok: true, skipped: "busy" }
    state.dreaming.running = true
    try {
      const result = await dreamOnce(ctx)
      if (result?.ok !== false) {
        state.dreaming.lastAt = nowIso()
        state.dreaming.count++
        state.dreaming.lastResult = result.skipped ? `跳过：${result.skipped}` : `已派发 ${result.day} · ${result.session}`
      }
      return result
    } finally {
      state.dreaming.running = false
    }
  }
  // 自定义 Agent 定时任务：到点新开一条豆包会话，把提示词当首句投递；不等第一轮跑完。
  const agentScheduleRuntime = (id) =>
    (state.agentSchedules[id] ??= { lastAt: null, count: 0, lastResult: null, running: false, nextAt: "" })
  const agentSchedulePrompt = (item, session, at) => {
    const pad = (n) => String(n).padStart(2, "0")
    const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    const cwd = agentScheduleCwd(item.cwd)
    return `# 定时任务：${item.label || item.id}

本会话由 Foreman 的 Agent 型定时任务「${item.label || item.id}」在 ${when} 按时开起，任务 ID：${item.id}，会话：${session}。
工作目录：${cwd}（记日志、写文件、发邮件附件的相对路径都按它解析；取不到相对路径时直接用这个前缀拼绝对路径）。
把下面这段任务当作本轮唯一目标；需要时直接调用工具取数，跑完在本会话给最终回复，不要转交给别的编排会话。

---

${String(item.prompt ?? "").trim()}
`
  }
  const runAgentSchedule = async (item) => {
    if (!item) return { ok: false, error: "定时任务不存在" }
    const runtime = agentScheduleRuntime(item.id)
    if (runtime.running) return { ok: true, skipped: "busy" }
    runtime.running = true
    const at = new Date()
    const pad = (n) => String(n).padStart(2, "0")
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
    const session = `foreman-${item.id}-${stamp}`
    try {
      // cwd 跟配置走（agentScheduleCwd）：提示词里宣称的工作目录必须是会话真实 cwd。
      const delivered = await ctx.dws.openNew({ name: session, prompt: agentSchedulePrompt(item, session, at), noWait: true, repo: agentScheduleCwd(item.cwd) })
      if (delivered?.ok === false) throw new Error(delivered.error || `Agent 定时任务 ${item.id} 投递失败`)
      runtime.lastAt = nowIso()
      runtime.count++
      runtime.lastResult = `已派发 ${session}`
      log(`Agent 定时任务 ${item.id} 已派发：${session}`)
      return { ok: true, dispatched: true, session, convId: String(delivered?.convId ?? "") }
    } finally {
      runtime.running = false
    }
  }
  const syncScheduleState = (items) => {
    const ids = { pickup: "pickup", prWatch: "pr", mail: "mail", router: "router", dreaming: "dreaming" }
    for (const [id, key] of Object.entries(ids)) {
      state[key].nextAt = items.find((item) => item.id === id)?.nextAt || ""
    }
    for (const item of customAgentSchedules(cfg)) {
      agentScheduleRuntime(item.id).nextAt = items.find((row) => row.id === item.id)?.nextAt || ""
    }
  }
  const buildScheduleExecutors = () => ({
    pickup: { type: "script", run: (_, { manual }) => runConfiguredScript(ctx, "pickup", { manual }) },
    prWatch: { type: "script", run: (_, { manual }) => runConfiguredScript(ctx, "prWatch", { manual }) },
    mail: { type: "script", run: () => recordMailPoll(() => runConfiguredScript(ctx, "mail")) },
    router: { type: "script", run: () => runConfiguredScript(ctx, "router") },
    dreaming: { type: "agent", run: recordDream },
    ...Object.fromEntries(
      customAgentSchedules(cfg).map((item) => [item.id, { type: "agent", run: () => runAgentSchedule(item) }])
    ),
  })
  scheduler = new ScheduleRunner({
    store: inbox,
    executors: buildScheduleExecutors(),
    allow: (schedule) => !["prWatch", "pickup"].includes(schedule.id) || inWorkHours(cfg),
    onChange: syncScheduleState,
    onError: (error) => log(`Schedule 异常：${error.message}`),
  })
  ctx.inboxSchedules = scheduler
  const armSchedules = () => {
    scheduler.executors = buildScheduleExecutors()
    scheduler.sync(scheduleDefinitions(cfg))
    saveScheduleSettings(inbox, cfg)
  }
  worker.start()
  dispatcher.start()
  armSchedules()
  scheduler.start(Number(cfg.inbox?.schedulePollMs ?? 1000))

  // 飞书通道（openclaw 式入站）：enabled 才动态加载 SDK；WS 长连接收消息 → Inbox chat.message，
  // 回复由泵轮询 router 会话增量经 Outbox lark 推回。启动失败只记日志，不挡服务。
  // 设备授权（控制台扫码/链接授权拿 open_id）独立于通道开关，常驻创建、随时可发起。
  ctx.feishu = null
  ctx.feishuPump = null
  const startFeishuChannel = async () => {
    if (!cfg.feishu?.enabled) return
    try {
      const { FeishuGateway, FeishuReplyPump } = await import("./feishu.mjs")
      const feishuGateway = new FeishuGateway({ cfg, ctx, log })
      await feishuGateway.start()
      ctx.feishu = feishuGateway
      const feishuPump = new FeishuReplyPump({ cfg, ctx, log })
      feishuPump.start()
      ctx.feishuPump = feishuPump
    } catch (e) {
      log(`飞书通道启动失败：${e.message}`)
      ctx.feishu = null
      ctx.feishuPump = null
      ctx.feishuError = e.message
    }
  }
  const stopFeishuChannel = () => {
    try {
      ctx.feishuPump?.stop()
      ctx.feishu?.stop()
    } catch {}
    ctx.feishu = null
    ctx.feishuPump = null
  }
  await startFeishuChannel()

  // 控制台「飞书」面板：读当前配置 + 通道/授权状态；保存 = 归一 → 写回 config.json → 通道热重启。
  ctx.feishuView = () => ({
    ok: true,
    config: cfg.feishu,
    gateway: ctx.feishu?.view?.() ?? null,
    error: ctx.feishuError ?? "",
  })
  ctx.applyFeishu = async (patch = {}) => {
    // groups 里界面只改 high：浅合并会把没传的 low 冲掉，这里先按层合并。
    const merged = { ...cfg.feishu, ...patch }
    if (patch.groups && typeof patch.groups === "object") merged.groups = { ...cfg.feishu.groups, ...patch.groups }
    const next = normalizeFeishuSection(merged)
    // 写回 config.json（保留其余键；文件不存在就落在解析出的配置路径上）。
    let fileData = {}
    try {
      fileData = JSON.parse(fs.readFileSync(cfg.configFile, "utf8"))
    } catch {}
    fileData.feishu = next
    fs.mkdirSync(path.dirname(cfg.configFile), { recursive: true })
    fs.writeFileSync(cfg.configFile, JSON.stringify(fileData, null, 2) + "\n")
    cfg.feishu = next
    stopFeishuChannel()
    ctx.feishuError = ""
    await startFeishuChannel()
    log(`飞书配置已保存并当场生效：enabled=${next.enabled} · 高优群 ${next.groups.high.length} · 白名单 ${next.allowUsers.length}`)
    return ctx.feishuView()
  }

  // 控制台「项目」面板：读当前产品/工程；保存 = 同 loadConfig 一套校验 → 原子写回 config.json →
  // 原地热替换 cfg.products/cfg.repos。所有轮询/派单/PR 消费点都现读 cfg.repos，下一轮即生效，
  // 不用重启（改 base 只影响之后新建的工作区；在途工单仍按账本记录的旧基线走）。
  ctx.productsView = () => ({ ok: true, configFile: cfg.configFile, products: cfg.products })
  ctx.applyProducts = (patch = {}) => {
    const list = Array.isArray(patch.products) ? patch.products : []
    if (!list.length) throw new Error("products 不能为空（至少保留一个产品与一条 repos）")
    // 校验与 loadConfig 同一套 normalize（repo 正则、dir/base 必填、promptFile 存在性）。
    const next = normalizeProducts({ ...cfg, products: list }, path.dirname(cfg.configFile))
    // 在途安全：Book 里 state ∈ RUNNING_STATES 的工单记着旧工程/旧基线。
    const book = new Book(cfg.stateFile)
    const inflight = new Map() // repo -> [issueKey]
    for (const it of runningIssues(book)) {
      const repos = new Set([it.repo, ...(it.workspaces ?? []).map((w) => w.repo)].filter(Boolean))
      for (const r of repos) inflight.set(r, [...(inflight.get(r) ?? []), it.key])
    }
    const nextRepos = new Map(next.flatMap((p) => p.repos.map((r) => [r.repo, r])))
    const removed = [...inflight.keys()].filter((r) => !nextRepos.has(r))
    if (removed.length && patch.force !== true) {
      throw Object.assign(
        new Error(`这些工程还有在途工单，删掉后不再被监控：${removed.join("、")}；确认删除请用强制保存`),
        { code: "repo_busy", repos: removed, inflight: removed.map((r) => ({ repo: r, issues: inflight.get(r) })) },
      )
    }
    const warnings = []
    for (const old of cfg.repos ?? []) {
      const nw = nextRepos.get(old.repo)
      const keys = inflight.get(old.repo) ?? []
      if (nw && nw.base !== old.base && keys.length) {
        warnings.push(`${old.repo} 基线 ${old.base} → ${nw.base}：${keys.length} 个在途工单仍按账本记录的旧基线走（${keys.join("、")}），新基线只影响之后新建的工作区`)
      }
    }
    // 原子写回 config.json（保留其余键；tmp+rename 防半截文件，同 persistAgent）。
    let fileData = {}
    try {
      fileData = JSON.parse(fs.readFileSync(cfg.configFile, "utf8"))
    } catch {}
    fileData.products = next
    fs.mkdirSync(path.dirname(cfg.configFile), { recursive: true })
    const tmp = `${cfg.configFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(fileData, null, 2) + "\n")
    fs.renameSync(tmp, cfg.configFile)
    // 热替换：保持 loadConfig 的共享引用不变式（cfg.repos 与 products[].repos 同一批对象），
    // 消费点每轮现读，下一轮即生效；顺手清候选缓存。
    cfg.products = next
    cfg.repos = next.flatMap((p) => p.repos)
    forgetCandidates()
    log(`项目配置已保存并当场生效：${next.length} 个产品 · ${cfg.repos.length} 条工程${warnings.length ? ` · ${warnings.length} 条基线变更提醒` : ""}`)
    return { ...ctx.productsView(), warnings }
  }

  // 页面上启停定时任务：改内存 cfg → 写 SQLite → 立刻重排定时器，不再写 config.json。
  const schedulesView = () => listSchedules(cfg, state)
  const workHoursView = () => ({
    days: [...(cfg.workHours?.days ?? [1, 2, 3, 4, 5])],
    start: String(cfg.workHours?.start ?? "08:30"),
    end: String(cfg.workHours?.end ?? "18:30"),
  })
  ctx.schedules = schedulesView
  ctx.workHours = workHoursView
  ctx.applySchedules = (patch = {}) => {
    applySchedules(cfg, patch)
    armSchedules()
    const view = schedulesView()
    log(`定时任务已写入 SQLite：${Object.keys(patch).join(",")}`)
    log(`定时任务开关：${view.map((s) => `${s.id}=${s.enabled ? "on" : "off"}`).join(" ")}`)
    return view
  }
  // 新建 Agent 定时任务：写 cfg → 重排定时器（落 SQLite）→ 首次触发排到下一个 cron 点。
  // 不重启、不改配置文件；要立刻跑一次走 /api/schedules/run。
  ctx.createSchedule = (input = {}) => {
    const { item, created } = createAgentSchedule(cfg, input)
    armSchedules()
    if (created) {
      const next = firstRunAt(item.cron, new Date())
      inbox.db.prepare("UPDATE agent_schedules SET next_at = ?, updated_at = ? WHERE id = ?")
        .run(next ? next.toISOString() : null, nowIso(), item.id)
      agentScheduleRuntime(item.id).nextAt = next ? next.toISOString() : ""
    }
    log(`Agent 定时任务已${created ? "新建" : "覆盖"}：${item.id} · ${item.cron} · ${item.enabled ? "启用" : "停用"}`)
    return schedulesView()
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    if (state.interval) clearInterval(state.interval)
    if (state.prInterval) clearTimeout(state.prInterval)
    if (state.prKick) clearTimeout(state.prKick)
    if (state.pickupInterval) clearTimeout(state.pickupInterval)
    if (state.pickupKick) clearTimeout(state.pickupKick)
    if (state.mailInterval) clearTimeout(state.mailInterval)
    if (state.mailKick) clearTimeout(state.mailKick)
    if (state.routerInterval) clearTimeout(state.routerInterval)
    if (state.routerKick) clearTimeout(state.routerKick)
    if (state.mergeInterval) clearTimeout(state.mergeInterval)
    if (state.mergeKick) clearTimeout(state.mergeKick)
    await scheduler?.stop()
    await dispatcher?.stop()
    await worker?.stop()
    try {
      ctx.feishuPump?.stop()
      ctx.feishu?.stop()
    } catch {}
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

  return {
    server: consoleHttp.server, close, poll: doPoll, prPoll: doPrPoll, pickup: doPickup, router: doRouter, inspector: doRouter,
    worker, inbox, outbox, dispatcher, schedules: scheduler, port, portFile: paths.portFile, http: ctx.httpUrl,
    // 载体查看/热切换与引擎透出（控制台与测试用）；ctx 给测试直通 feishu 面板等方法。
    getAgent: ctx.getAgent, setAgent: ctx.setAgent, engine, ctx, cfg,
  }
}

// 本人 UI PR 的验收指派：router agent显式触发，Foreman 复核本人/UI/open 后按配置顺序轮询。
// 这里只改 Gitea assignees，不创建合并助手、不合并；指派成功才推进游标。
export async function prUiAssignOnce(ctx, { repo = "", number = 0 } = {}) {
  const r = String(repo ?? "").trim()
  const n = Number(number) || 0
  if (!r || !n) return { ok: false, error: "bad-request", message: "pr ui-assign 需要 repo 和 PR 编号" }
  if (!uiReviewersReady(ctx.cfg)) {
    return { ok: false, error: "reviewer-config", message: "prWatch.uiReviewers 需要完整的 name 和 Gitea username，配置不完整时不指派" }
  }
  if (ctx.state.prUiAssignRunning) return { ok: false, error: "busy", message: "另一条 UI 验收指派正在执行，请稍后重试" }
  ctx.state.prUiAssignRunning = true
  try {
    const key = prKey(r, n)
    const book = new Book(ctx.cfg.stateFile)
    const seen = book.prSeen[key] ?? null
    if (seen?.reviewAssignedAt) {
      return {
        ok: true, skipped: "already-assigned", repo: r, pr: n,
        reviewer: { name: seen.reviewerName || seen.reviewer, username: seen.reviewer },
      }
    }
    let view
    try {
      view = await ctx.gitea.viewPr(r, n, { files: true })
    } catch (e) {
      return { ok: false, error: "gitea-error", message: e.message }
    }
    const pr = Array.isArray(view) ? view[0] : view
    if (String(pr?.state ?? "open") !== "open") return { ok: false, error: "not-open", message: `${key} 不是 open 状态，不能指派验收` }
    if (!isOwnPr({ ...pr, repo: r, number: n }, ctx.cfg, book)) {
      return { ok: false, error: "not-own-pr", message: `${key} 不是本人 PR；他人 PR 只能走 pr assign 分配合并助手` }
    }
    if (!isUiPrView(view, ctx.cfg, { key, book, seen })) {
      return { ok: false, error: "not-ui-pr", message: `${key} 未确认涉及 UI，不做测试验收指派` }
    }

    const reviewers = uiReviewers(ctx.cfg)
    const assignees = (Array.isArray(pr?.assignees) ? pr.assignees : []).map((x) => String(x ?? "").trim()).filter(Boolean)
    const existing = reviewers.find((x) => assignees.includes(x.username))
    if (existing) {
      const b = new Book(ctx.cfg.stateFile)
      b.markPrSeen(key, { ...pr, repo: r, number: n, skipped: "self", ui: true, reviewer: existing.username, reviewerName: existing.name, reviewAssignedAt: nowIso() })
      b.setPrReviewRr(reviewers.indexOf(existing) + 1)
      return { ok: true, skipped: "already-assigned", repo: r, pr: n, reviewer: existing }
    }
    if (assignees.length) {
      return { ok: true, skipped: "assigned-to-other", repo: r, pr: n, assignees, message: `已有其他指派人：${assignees.join("、")}，未改动` }
    }

    const idx = book.prReviewRr % reviewers.length
    const reviewer = reviewers[idx]
    try {
      await ctx.gitea.assign(r, n, reviewer.username)
    } catch (e) {
      return { ok: false, error: "gitea-error", message: `指派 ${reviewer.name}（${reviewer.username}）失败：${e.message}` }
    }
    const b = new Book(ctx.cfg.stateFile)
    b.markPrSeen(key, { ...pr, repo: r, number: n, skipped: "self", ui: true, reviewer: reviewer.username, reviewerName: reviewer.name, reviewAssignedAt: nowIso() })
    b.setPrReviewRr(idx + 1)
    ctx.consoleStore?.event({ kind: "pr_ui_assign", key, repo: r, number: n, to: reviewer.username, detail: `本人 UI PR 验收指派给 ${reviewer.name}` })
    ctx.log?.(`本人 UI PR ${key} 已指派 ${reviewer.name}（${reviewer.username}）验收；下一位轮询`)
    return { ok: true, repo: r, pr: n, reviewer, assignees: [...assignees, reviewer.username] }
  } finally {
    ctx.state.prUiAssignRunning = false
  }
}

// router agent显式分配一条他人 PR：这里才创建合并助手；本人或作者不明一律拒绝。
export async function prAssignOnce(ctx, { repo = "", number = 0 } = {}) {
  const repoName = String(repo ?? "").trim()
  const prNumber = Number(number)
  if (!repoName || !prNumber) return { ok: false, error: "bad-request", message: "pr assign 需要 repo 与 number" }
  try {
    const raw = await ctx.gitea.viewPr(repoName, prNumber)
    const view = Array.isArray(raw) ? raw[0] : raw
    if (!view) return { ok: false, error: "not-found", message: `找不到 PR ${repoName}#${prNumber}` }
    const pr = { ...view, repo: repoName, number: prNumber }
    if (String(pr.state ?? "open") !== "open") {
      return { ok: false, error: "not-open", message: `PR ${repoName}#${prNumber} 不是 open，不能分配合并助手` }
    }
    const key = prKey(repoName, prNumber)
    const book = new Book(ctx.cfg.stateFile)
    const seen = book.prSeen[key] ?? {}
    const previousSession = String(seen.assignedTo ?? (seen.via === "new-session" ? seen.notifiedTo : "") ?? "").trim()
    if (previousSession) {
      return {
        ok: true,
        skipped: "already-assigned",
        session: previousSession,
        convId: String(seen.assignedConvId ?? seen.convId ?? ""),
        repo: repoName,
        number: prNumber,
      }
    }
    if (ownedPrKeys(book).has(key) || !shouldReport(pr, ctx.cfg)) {
      return {
        ok: false,
        error: "own-or-unknown-author",
        message: `只允许分配明确由他人创建的 PR；${repoName}#${prNumber} 的作者为 ${pr.author || "未知"}，不分配、不合并`,
      }
    }
    // 人工补派也只投 router：由它核对后执行 foreman pr merge。
    await routeToRouter(ctx, {
      type: "pr.merge",
      text: `【Foreman · 他人 PR 待合并（人工补派）】\n${prNotifyText([pr])}\n请核对后执行 foreman pr merge ${prNumber} --repo ${repoName}（幂等，合不了会回理由），合完再 foreman clean 关单清尾。`,
      json: { prs: [pr] },
    })
    const assignedAt = nowIso()
    const saved = new Book(ctx.cfg.stateFile)
    saved.markPrSeen(key, { ...pr, notifiedTo: "router", via: "router", assignedTo: "router", assignedAt })
    return { ok: true, action: "routed", router: true, repo: repoName, number: prNumber, assignedAt }
  } catch (e) {
    return { ok: false, error: "pr-assign-failed", message: e.message }
  }
}

// Worker 的 pr.merge handler：Inbox 里的一条候选事件 → 一条合并助手会话。
// 扫描只写意图，真正的建会话、投递、记账都在这里；失败抛错由 Inbox 统一重试，重启由 SQLite 恢复。
// 重复事件（同一 PR 被两轮扫描各入箱一次）靠账本 assignedTo / notifiedAt 过滤，不会重复建会话。
// Worker 的 pr.merge handler：不再开合并助手会话——合并请求投 router agent，
// 由它核对后直接执行 foreman pr merge（幂等）。账本 notifiedTo 记 router，去重逻辑不变。
export async function deliverMergeCandidate(ctx, event) {
  const payload = event?.payload ?? {}
  const list = Array.isArray(payload.prs) ? payload.prs : []
  if (!list.length) return { ok: true, skipped: "empty" }
  const book = new Book(ctx.cfg.stateFile)
  const todo = list.filter((pr) => {
    const seen = book.prSeen[pr.key] ?? {}
    return !seen.assignedTo && !seen.notifiedAt
  })
  if (!todo.length) return { ok: true, skipped: "already-assigned", prs: list.map((pr) => pr.key) }

  const text = String(payload.text ?? "").trim() || prNotifyText(todo)
  await routeToRouter(ctx, {
    type: "pr.merge",
    text: `【Foreman · 他人 PR 待合并】\n${text}\n请核对后逐条执行 foreman pr merge <N> --repo <仓库>（幂等，合不了会回理由），合完的工单再 foreman clean 关单清尾；不要自己改代码。`,
    json: { prs: todo },
  })
  const assignedAt = nowIso()
  const saved = new Book(ctx.cfg.stateFile)
  for (const pr of todo) {
    saved.markPrSeen(pr.key, { ...pr, notifiedTo: "router", via: "router", assignedTo: "router", assignedAt })
  }
  ctx.log?.(`pr.merge 已投 router（${todo.map((pr) => pr.key).join("、")}）`)
  return { ok: true, action: "routed", router: true, prs: todo.map((pr) => pr.key), assignedAt }
}

// 我的工单扫描一轮：只把「指派给我 + ready-for-agent」候选写入 router agent Inbox。
// 不接单、不调用旧 pickupOnce；容量与 hand/dispatch 决策归 router agent 和工单编排。
export async function pickupPollOnce(ctx, { force = false } = {}) {
  const { state, cfg, gitea, log } = ctx
  if (cfg.pickup?.auto !== true && !force) return { ok: true, skipped: "disabled" }
  if (state.pickup.polling) return { ok: true, skipped: "busy" }
  if (ctx.engine?.paused?.("pickup")) return { ok: true, skipped: "node-paused" }
  state.pickup.polling = true
  try {
    const notifyRouter = ctx.notifyRouter ?? ctx.notifyInspector ?? (async (text) => routerOnce(ctx, { force: true, notice: text }))
    const out = await pickupWatchOnce({ cfg, gitea, log, inspect: notifyRouter })
    state.pickup.lastPollAt = nowIso()
    state.pickup.pollCount = Number(state.pickup.pollCount ?? 0) + 1
    state.pickup.notifiedCount = Number(state.pickup.notifiedCount ?? 0) + Number(out.notified ?? 0)
    state.pickup.pending = Number(out.pending ?? 0)
    state.pickup.lastScanResult = `检查 ${Number(out.checked ?? 0)} 条 · 入箱 ${Number(out.notified ?? 0)} 条 · 待重试 ${Number(out.pending ?? 0)} 条`
    return out
  } catch (error) {
    log(`我的工单扫描失败：${error.message}`)
    return { ok: false, error: error.message }
  } finally {
    state.pickup.polling = false
  }
}

// PR 扫描一轮：配置里每个仓库列 open PR → 过滤作者 → 去重 → 他人 PR 写 pr.merge Inbox，
// 由 Worker 派合并助手；本人 UI 候选与评论更新才写 router agent Inbox。
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
    const notifyRouter = ctx.notifyRouter ?? ctx.notifyInspector ?? (async (text) => routerOnce(ctx, { force: true, notice: text }))
    const target = String(book.data.router?.convId ?? book.data.inspector?.convId ?? "").trim()
    state.pr.target = target
    let out
    try {
      // 他人 PR 只写 pr.merge Inbox，扫描不建会话；Worker 的 pr.merge handler 才派合并助手。
      // 本人 UI 候选与评论更新仍交 router agent。没有 Inbox 时退回直投（旧部署/测试）。
      const enqueueMerge = ctx.inbox ? (event) => ctx.inbox.enqueue(event) : null
      out = await prWatchOnce({ cfg, gitea, dws, log, target, inspect: notifyRouter, enqueue: enqueueMerge })
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

// 跑一轮：现读 book → 观察 watcher 状态与最终回复 → 只写 task.update Inbox；Worker 投递后才消费指纹。
export async function pollOnce(ctx) {
  const { state, cfg, dws, log, gitea } = ctx
  // 直接构造 ctx 的调用方（测试/脚本）没有 engine 时补一个，保证流程事件照样发。
  const engine = ctx.engine ?? new WorkflowEngine({ cfg, session: dws, tracker: gitea, log })
  if (state.polling) return { checked: 0, settled: 0, notified: 0, steered: 0, skipped: "busy" }
  state.polling = true
  const out = { checked: 0, settled: 0, notified: 0, steered: 0 }
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
      // - 这次收工已经处理过 → 直接跳过，一个字节都不读；
      // - 没在跑、还没处理过 → 收工这轮读一次 status 判结论，该通知就通知。
      // 侧边栏再把它报成 running，或 resume/重派显式 steer 时才清掉 idle，等下一次收工。
      // 即使 runningMap 暂时不可用，也不能为了确认同一份 RESULT 每轮重复 status。
      book.reload()
      const led = book.notified[key] ?? {}
      if (side?.running) {
        if (led.idle) book.clearIdle(key)
        if (led.gone) book.clearGone(key)
        // running 只是「还在跑」，不产生业务信息：只落本地账本，不入箱、不投递编排。
        // 编排只需要收工（finished/settled）；gone 多为正常归档，同样不投递。
        if (led.observedPhase !== "running") book.markTaskObserved(key, "running")
        rec.lastPhase = "running"
        rec.lastPollAt = nowIso()
        continue
      }
      // 侧边栏里根本没有这条（已归档/已收起）：只记 gone，不读 status。
      // status 切不过去，只会回「侧边栏里没有任务」，每轮刷一次日志、白拽一次窗口。
      // 归档是正常收尾，不打扰编排：与 running 一样只落本地账本，不入箱、不投递。
      if (sidebar && !side) {
        if (!led.gone) {
          book.markTaskObserved(key, "gone")
          book.markGone(key)
        }
        rec.lastPhase = "gone"
        rec.lastPollAt = nowIso()
        continue
      }
      // 又回到侧边栏里了：清 gone，这一轮重新判一次（中间可能又跑完过一轮）。
      if (side && led.gone) {
        book.clearGone(key)
      }
      if (led.idle) {
        rec.lastPhase = "idle"
        rec.lastPollAt = nowIso()
        continue
      }
      // 收工处理完（无论通知了还是没什么可通知）就落成 idle。
      // 后续只有侧边栏 running 或 resume/重派 steer 才唤醒；runningMap 失败也不能重复读旧 RESULT。
      const park = () => new Book(cfg.stateFile).markIdle(key)
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
        if (decision.phase !== "running") {
          // resume 先清 idle，侧边栏和 status 却可能还没进入新一轮；此时读到的旧指纹
          // 不能再次落 idle，否则真正的新 RESULT 会被上面的 idle 分支永久跳过。
          const waitingForResumedResult = decision.phase === "finished"
            && Boolean(prev.wokeAt) && prev.fingerprint === decision.fingerprint
          // 同一指纹重试到上限还没送达：明确记一条日志再休眠，免得以后查不到「为什么没回」。
          const attempts = Number(prev.attempts ?? 0)
          const gaveUp = decision.phase === "finished"
            && prev.fingerprint === decision.fingerprint
            && attempts >= notifyMaxAttempts(cfg)
          if (gaveUp) log(`放弃通知 ${w.target}：同一结论已尝试 ${attempts} 次仍未送达（${prev.lastError || "无错误信息"}）`)
          if (!waitingForResumedResult) park()
        }
        continue
      }

      // 跑完且指纹变了：只读取最终回复并写持久 Inbox。不得在这里解析 RESULT、
      // 推进工单业务状态、push/开 PR 或直接给编排发消息；这些决定统一交给所属编排。
      let finalText = ""
      try {
        const info = await dws.info(w.target)
        finalText = String(info?.lastReply ?? "").trim()
      } catch (e) {
        state.dwsErrors++
        log(`dws info ${w.target} 失败：${e.message}`)
      }

      if (ctx.engine?.paused?.("notify")) {
        log(`任务事件跳过 ${w.target}：通知节点已暂停`)
        continue
      }
      // 已合并归档的会话不再补一条重复结论；其余任务一律经 task.update 事件路由。
      const issKey = String(w.issueKey ?? "")
      const book2 = new Book(cfg.stateFile)
      const iss = issKey ? book2.issue(issKey) : null
      const prOf = Number(iss?.pr ?? 0)
      const mergeKey = prOf ? `${w.repo || String(issKey).split("#")[0]}#${prOf}` : ""
      const merged = mergeKey && book2.mergeAsk?.[mergeKey]?.status === "merged"
      if (merged) {
        const payload = { issueKey: issKey, target: w.target, kind: "archived-skip", detail: "会话已归档，跳过通知" }
        book2.markNotified(w.target, decision.fingerprint, { phase: decision.phase, chars: status?.chars ?? 0 })
        if (engine.lifecycle && typeof engine.lifecycle.emit === "function") await engine.lifecycle.emit("notice.delivered", payload)
        else await engine.emit("notice.delivered", payload)
        log(`通知跳过 ${w.target}：工单已关单合并（会话已归档，不再通知编排会话）`)
        park()
        continue
      }

      const published = enqueueTaskUpdate({ ...ctx, book: book2 }, {
        watcher: w,
        phase: decision.phase,
        fingerprint: decision.fingerprint,
        finalText,
      })
      if (!published.ok) {
        log(`任务事件未入箱 ${w.target}：${published.reason}；不落 idle，下一轮重试`)
        continue
      }
      out.enqueued = (out.enqueued ?? 0) + (published.status === "pending" ? 1 : 0)
      rec.eventQueuedAt = nowIso()
      log(`任务事件已入箱 ${w.target}：${decision.phase} → ${published.owner}（等待 Worker 投递）`)
      // 关键：enqueue 只代表持久化，不能 park；deliverTaskUpdate 成功 queue 后才 markIdle。
    }
    // 收口工单的编排会话也在这轮收：工单 done 之后它没有下一件事了，
    // 不收就会每张单在侧边栏留一条「工单编排」，越积越多。复用同一份侧边栏判断在不在跑。
    try {
      const orchNotes = await archiveFinishedOrchestrators({ dws, stateFile: cfg.stateFile, log, sidebar })
      if (orchNotes.length) out.orchestratorArchive = orchNotes
    } catch (e) {
      log(`归档收口工单的编排会话失败：${e.message}`)
    }
    state.lastPollAt = nowIso()
    state.pollCount++
    state.lastPollResult = `检查 ${out.checked} · 收工 ${out.settled} · 通知 ${out.notified} · 续跑 ${out.steered}`
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
  // 拆分 merge/clean：默认只做合并与落账（merge + pr-open 节点），关单、摘监听、删工作区、
  // 归档一律归 `foreman clean`（PR 全合完才动手）。task.cleanup === true 才跑完整收尾链（兼容保留）。
  const doCleanup = task.cleanup === true
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

  // 合并要指明「哪张单、哪个工程、哪块 worktree（有的话）」：工程是 PR 所在仓库，
  // worktree/分支取账本里这张单的实现工作区（一工程一工作区时按 repo 对号），没有就写「无」。
  const recOf = plannedKey ? (book0.issue?.(plannedKey) ?? {}) : {}
  const wsOf = (Array.isArray(recOf.workspaces) ? recOf.workspaces : []).find((x) => String(x?.repo ?? "") === repo) ?? null
  const worktree = String(task.worktree ?? wsOf?.worktree ?? recOf.worktree ?? "").trim()
  const branch = String(task.branch ?? wsOf?.branch ?? recOf.branch ?? "").trim()
  const where = `工程 ${repo}${worktree ? ` · worktree ${worktree}` : " · 无 worktree"}`
  if (!worktree) log(`合并 ${repo}#${pr}：账本里没有工作区记录（可能是别人的 PR，或工作区已经清掉）`)

  if (book0.mergeAsk?.[key]?.status === "merged" && task.alreadyMerged !== true) {
    book0.markMergeTask(key, { status: "merged", detail: "账本里已是合并状态" })
    // 也把工单键带回去：同步回包要能说清「这条 PR 属于哪张单」，别只回一个 skipped。
    return { ok: true, skipped: "already-merged", alreadyMerged: true, issueKey: plannedKey, worktree, branch, notes: [] }
  }

  // 验收闸门：PR 涉及 UI、且验收邮件已经发出去在等回复时，先不许合。
  // 邮件验收通过后 applyVerdict 会把 approvedBy 带进来；编排也可以显式 --approved-by（用户当面回了「合并」）。
  // 没开邮件 / 不是 UI / 测试同学还没配真邮箱时一律放行，不把原来的流程卡死。
  const gate = await acceptanceGate(ctx, {
    repo,
    pr,
    issueKey: plannedKey,
    url: String(task.url ?? ""),
    title: String(recOf.title ?? ""),
    ui: task.ui === true,
    approvedBy: String(task.approvedBy ?? ""),
  })
  if (!gate.allow) {
    new Book(cfg.stateFile).markMergeAsked(key, {
      pr,
      url: String(task.url ?? ""),
      status: "waiting",
      error: gate.message,
    })
    log(`合并 ${repo}#${pr} 等 UI 验收：${gate.message}`)
    return { ok: false, reason: gate.reason, message: gate.message, gate, worktree, branch, issueKey: plannedKey }
  }
  if (gate.note) log(`合并 ${repo}#${pr}：${gate.note}`)

  const op = startOperation(ctx, "merge", `合并 PR ${repo}#${pr}`, {
    key,
    detail: `${style} · 并发 ${cfg.merge?.concurrency ?? 1} · 不 force merge · ${where}`,
  })
  let alreadyMerged = task.alreadyMerged === true
  // 「他人 PR」流程：动手合之前先记一笔「核对完、决定合」。
  if (workflow === "review") {
    await ctx.engine?.emit("pr.reviewed", { key, pr, repo, target: task.target ?? "", workflow })
  }
  // 手动完成已经先核对过远端 merged，只补本地收尾，不能再发一次合并请求。
  if (!alreadyMerged) {
    try {
      await ctx.gitea.mergePr(repo, pr, { style, deleteBranch })
    } catch (e) {
      const msg = String(e?.message ?? e ?? "")
      // 「已经合并」不算失败：REST 包对已合的 PR 回 empty_result + 提示无需重复合并。
      if (/无需重复合并|已经合并|已合并/.test(msg)) {
        alreadyMerged = true
        log(`${repo}#${pr} 已经是合并状态，按已合并收尾（${key}）`)
      } else {
        const reason = await mergeFailureReason({ gitea: ctx.gitea, repo, pr, error: e })
        const b = new Book(cfg.stateFile)
        b.markMergeAsked(key, { pr, url: task.url ?? "", status: "failed", error: reason })
        b.markMergeTask(key, { status: "failed", error: reason, repo, worktree, branch })
        log(`合并失败 ${repo}#${pr}（${where}）：${reason}`)
        finishOperation(ctx, op, "failed", reason)
        // 失败也只记账：通知暂停期间不回执给任何人，负责合并的一方从控制台/账本看原因。
        return { ok: false, reason }
      }
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
      stages: doCleanup ? null : ["merge", "pr-open"],
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
      stages: doCleanup ? null : ["merge", "pr-open"],
    })
  }

  // 通知会话收尾：只在完整收尾（cleanup）时归档；合并-only 模式归 clean 负责。
  let archivedNotes = []
  if (doCleanup) {
    try {
      archivedNotes = await archiveMergedNotices({ dws: ctx.dws, stateFile: cfg.stateFile, log })
    } catch (e) {
      log(`归档通知会话失败：${e.message}`)
    }
  }
  const notes = [...(done.notes ?? []), ...(cleanup?.notes ?? []), ...archivedNotes]
  const book = new Book(cfg.stateFile)
  book.markMergeTask(key, { status: "merged", mergedAt: nowIso(), notes, repo, worktree, branch })
  ctx.consoleStore?.event({
    kind: "pr_merge", key, repo, number: pr, worktree, branch,
    to: "merged", detail: `${style}${resolvedNo ? ` · 关单 #${resolvedNo}` : ""}${alreadyMerged ? " · 原本已合并" : ""} · ${where}`,
  })
  try { ctx.consoleStore?.sync(new Book(cfg.stateFile)) } catch {}
  finishOperation(ctx, op, "success", `${alreadyMerged ? "原本已合并" : "合并成功"} · ${where}${notes.length ? ` · ${notes.join("；")}` : ""}`)
  log(`合并通道：已合并 ${repo}#${pr}（${key}）${resolvedNo ? `，关单 #${resolvedNo}` : ""} · ${where}`)
  // 合并结果不主动推消息给编排会话：收尾（关单、clean）由编排智能体自己主动调用，
  // 结果只落账本 + 控制台（foreman tasks / merge 记录 / 控制台「操作日志」）。
  // 兼容旧调用点；kickPickup 现在固定返回 false，不再由代码补单。
  // 只认真的关单（resolvedNo）：别人的 PR / 只是合了 PR 没关联工单的，不占接单名额也不续跑。
  if (resolvedNo) kickPickup(ctx, `${resolvedKey} 合并关单`)
  return { ok: true, alreadyMerged, notes, repo, issueKey: resolvedKey, worktree, branch }
}

// 控制台「手动完成」：只处理“远端已经合并、foreman 还没收尾”的工单。
// 先逐条核对 PR 的远端状态，再复用合并后的关单/清理链路；不重复合并，也不把 open PR 直接标 done。
export async function completeIssue(ctx, { repo = "", number = 0 } = {}) {
  const issueRepo = String(repo ?? "").trim()
  const issueNo = Number(number ?? 0) || 0
  const issueKey = `${issueRepo}#${issueNo}`
  if (!issueRepo || !issueNo) return { ok: false, error: "bad-request", message: "手动完成需要 repo / number" }

  const book = new Book(ctx.cfg.stateFile)
  const rec = book.issue?.(issueKey)
  if (!rec) return { ok: false, error: "unknown-issue", message: `账本里没有这条工单：${issueKey}` }
  if (rec.state === "done") {
    const cleaned = await cleanIssue(ctx, { issueKey })
    kickPickup(ctx, `${issueKey} 手动完成`)
    return { ok: true, skipped: "already-done", repo: issueRepo, number: issueNo, notes: cleaned.notes ?? [] }
  }

  const prs = (Array.isArray(rec.prs) && rec.prs.length
    ? rec.prs
    : [{ repo: issueRepo, pr: rec.pr, prUrl: rec.prUrl ?? "", branch: rec.branch ?? "" }]
  ).map((p) => ({
    repo: String(p?.repo ?? issueRepo).trim(),
    pr: Number(p?.pr ?? p?.number ?? 0) || 0,
    url: String(p?.prUrl ?? p?.url ?? ""),
    branch: String(p?.branch ?? ""),
  })).filter((p) => p.repo && p.pr)
  if (!prs.length) return { ok: false, error: "no-pr", message: `${issueKey} 还没有关联 PR，不能按已合并收尾` }

  const views = []
  for (const p of prs) {
    let raw
    try {
      raw = await ctx.gitea.viewPr(p.repo, p.pr)
    } catch (e) {
      return { ok: false, error: "pr-view-failed", message: `读取 ${p.repo}#${p.pr} 失败：${e.message}` }
    }
    const view = Array.isArray(raw) ? raw[0] : raw
    const state = String(view?.state ?? "").trim().toLowerCase()
    if (state !== "merged") {
      return {
        ok: false,
        error: "pr-not-merged",
        message: `${p.repo}#${p.pr} 当前是 ${state || "未知"}，只有已合并的 PR 才能手动完成`,
        repo: p.repo,
        pr: p.pr,
        state,
      }
    }
    views.push({ ...p, view })
  }

  const notes = []
  for (const p of views) {
    // 与 CLI 合并共用串行链，避免页面连点或别的合并请求同时写账本。
    const prev = ctx.mergeChain ?? Promise.resolve()
    const run = () => runMergeTask(ctx, {
      key: `${p.repo}#${p.pr}`,
      repo: p.repo,
      pr: p.pr,
      issue: issueNo,
      url: p.url,
      branch: p.branch,
      alreadyMerged: true,
      source: "manual-complete",
      notify: false,
      workflow: "own",
    })
    const mine = prev.then(run, run)
    ctx.mergeChain = mine.then(() => {}, () => {})
    const result = await mine
    if (!result?.ok) return { ok: false, error: "complete-failed", message: result?.reason ?? `${p.repo}#${p.pr} 收尾失败` }
    notes.push(...(result.notes ?? []))
  }
  // afterMerge 的 cleanup 节点只收流程产物；手动完成还要复用 `foreman clean` 的全量幂等清理，
  // 覆盖 worktree、本地分支、执行会话与 watch，避免旧账本只变成 done 却留下残留。
  const cleaned = await cleanIssue(ctx, { issueKey })
  if (!cleaned.ok) return { ok: false, error: "cleanup-failed", message: cleaned.reason ?? `${issueKey} 清理失败`, notes }
  notes.push(...(cleaned.notes ?? []))
  try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
  // 收尾完成 = 这张单真的结束了：立刻补下一张（同 runMergeTask 的续跑口径）。
  kickPickup(ctx, `${issueKey} 手动完成`)
  return { ok: true, repo: issueRepo, number: issueNo, completed: true, prs: views.map((p) => ({ repo: p.repo, pr: p.pr })), notes }
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
// REST 包对已经合并的 PR 会回 empty_result + 提示「无需重复合并」，字面当失败的话台账
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
  stages = null,
} = {}) {
  // 拆分 merge/clean：stages 缺省全跑；合并-only 传 ["merge","pr-open"]（不关单、不清工作区）。
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
  const want = Array.isArray(stages) && stages.length ? (s) => stages.includes(s) : () => true
  for (const stage of ["merge", "close", "pr-open", "dispatch"].filter(want)) {
    notes.push(...(await runNodeCleanup(stage, ctx)).notes)
  }
  // workspace 节点处置账本里的 worktree/分支；没有关联工单时它只回一句跳过说明。
  if (issueKeyResolved && want("workspace")) notes.push(...(await runNodeCleanup("workspace", ctx)).notes)
  if (want("cleanup")) notes.push(...(await runNodeCleanup("cleanup", ctx)).notes)
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
    notes.push(`worktree 已不在，跳过：${worktree}`)
  } else {
    let dirty = ""
    try {
      dirty = await statusPorcelain(worktree)
    } catch {}
    if (dirty) notes.push(`worktree 还有未提交改动，保留：${worktree}`)
    else if (await worktreeRemove(repoDir, worktree)) notes.push(`worktree 已删除：${worktree}`)
    else notes.push(`worktree 删除失败，保留：${worktree}`)
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
// 会话已经不存在的错误文案（dws 侧边栏找不到这条任务）。这类错误重试多少次都一样，
// 归档/收记录按「已经收过了」处理，别再每轮刷失败日志。
const SESSION_GONE = /侧边栏里没有任务/

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
      // 会话早就不在侧边栏里了（用户自己收的 / 早归档过）：这不是失败，
      // 记录留着只会每轮重试、每轮刷一行「归档失败」。收掉这条 notice，不再重试。
      if (SESSION_GONE.test(msg)) {
        new Book(stateFile).delNotice(target)
        notes.push(`通知会话 ${name} 已不在侧边栏，收掉记录`)
        log(`通知会话 ${name} 已不在侧边栏，收掉记录（不再重试）`)
        continue
      }
      // 归档不成功不推翻合并事实：只记一笔，下一轮再试（notice 记录留着）。
      notes.push(`通知会话 ${name} 归档失败：${msg.slice(0, 120)}`)
      log(`归档通知会话 ${name} 失败：${msg}`)
    }
  }
  return notes
}

// archiveFinishedOrchestrators：工单收口（已合并/已关单）后，把 foreman 自己为它建的那条编排会话归档。
// 早先 clean 只收工作会话与监听，没人管编排会话：每张单都在侧边栏留一条
// 「foreman-<仓库>-<单号>-编排」，一天几条，越积越多，而且点进去全是已经收尾的对话。
// 只动账本里 kind=orchestrator 且带这张单 issueKey 的会话：全局编排（book.orchestrator）
// 与用户自己发起后被绑成编排的会话一律不碰。还在跑的不收（它可能正拿着「下一步 clean」这一轮），
// 这一轮跳过、下一轮再试；dws 归档失败也留着账，不推翻工单状态。
export async function archiveFinishedOrchestrators({ dws, stateFile, log = () => {}, sidebar = null } = {}) {
  const notes = []
  if (!dws || typeof dws.archive !== "function" || !stateFile) return notes
  for (const [key, rec] of Object.entries(new Book(stateFile).issues ?? {})) {
    if (!TERMINAL_ISSUE_STATES.includes(String(rec?.state ?? ""))) continue
    const book = new Book(stateFile)
    const own = ownedIssueOrchestrator(book, key)
    if (!own) continue
    const target = own.convId || own.name
    // 侧边栏说还在跑：这一轮不动它（编排可能正拿着 clean 收尾）。
    if (sidebar && (sidebar[target]?.running || sidebar[String(own.convId ?? "")]?.running)) continue
    try {
      await dws.archive(target)
      const after = new Book(stateFile)
      after.delSession(own.name)
      after.setIssue(key, { orchestrator: "", orchestratorArchivedAt: nowIso() })
      notes.push(`编排会话 ${own.name || target} 已归档（${key}）`)
      log(`已归档收口工单的编排会话：${own.name || target}（${key}）`)
    } catch (e) {
      const msg = String(e?.message ?? e ?? "")
      // 会话已经不在侧边栏里（用户手动收了 / 早归档过）：不算失败，清掉绑定就不再重试。
      if (SESSION_GONE.test(msg)) {
        const after = new Book(stateFile)
        after.delSession(own.name)
        after.setIssue(key, { orchestrator: "", orchestratorArchivedAt: nowIso() })
        notes.push(`编排会话 ${own.name || target} 已不在侧边栏，收掉绑定（${key}）`)
        log(`编排会话 ${own.name || target} 已不在侧边栏，收掉绑定（${key}）`)
        continue
      }
      notes.push(`编排会话 ${own.name || target} 归档失败：${msg.slice(0, 120)}`)
      log(`归档编排会话 ${own.name || target} 失败：${msg}`)
    }
  }
  return notes
}

// 按 repo（owner/name）或 name（工程短名）找配置：命令行的 --repo 两种写法都认。
function findRepoCfg(cfg, ref) {
  const raw = String(ref ?? "").trim()
  if (!raw) return null
  return (cfg.repos ?? []).find((r) => r.repo === raw || r.name === raw) ?? null
}

// 这张单的编排会话是谁：自动接单是该单独立编排，用户自主发起是发起方自己的会话。
// 按 convId 归并，看每条编排会话手里有几条在跑的单。
export function boundInitiators(book) {
  const m = new Map()
  for (const [key, it] of Object.entries(book?.issues ?? {})) {
    if (!String(it?.agentConvId ?? "").trim()) continue
    const orch = String(it?.orchestrator ?? "").trim()
    if (!orch) continue
    if (!m.has(orch)) m.set(orch, [])
    m.get(orch).push(key)
  }
  return [...m.entries()].map(([convId, issues]) => ({ convId, issues }))
}

export async function handleRequest(ctx, req) {  const id = req?.id
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
      sessionFlow: {
        enabled: sessionFlowEnabled(ctx.cfg),
        orchestrator: orchestratorTarget(new Book(ctx.cfg.stateFile)),
        initiators: boundInitiators(new Book(ctx.cfg.stateFile)),
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
    // UI 验收：显式 --ui，或从这张单的 worktree diff 里认出前端文件。
    // 认到 UI 就立刻发验收邮件（主题带 [FM-…] 筛选 ID）；testers 还是占位符时只记 no-recipient，不报错。
    const acceptKey = issueNo ? `${issueRepo}#${issueNo}` : ""
    let ui = req.ui === true
    if (!ui && acceptKey) {
      const det = await detectUiChange({ cfg: ctx.cfg, issueKey: acceptKey, repo })
      ui = det.ui === true
    }
    let acceptance = null
    b.markPrSeen(`${repo}#${number}`, { repo, number, ui })
    if (ui) {
      if (acceptKey) b.setIssue(acceptKey, { ui: true })
      acceptance = await requestAcceptance(ctx, {
        repo,
        pr: number,
        url: pr.url ?? "",
        issueKey: acceptKey,
        title,
      })
      ctx.log?.(
        `PR 涉及 UI ${repo}#${number}：验收邮件${acceptance.ok ? `已发给 ${acceptance.to}（${acceptance.tag}）` : `跳过（${acceptance.skipped}）`}`
      )
    }
    // 约定：PR 开出就把工单交回人工——摘 ready-for-agent、打 ready-for-human。
    if (issueNo) {
      const label = ctx.gitea?.editLabels
      try {
        await label?.(issueRepo, issueNo, { add: "ready-for-human", remove: "ready-for-agent" })
        ctx.log?.(`工单 ${issueRepo}#${issueNo}：ready-for-agent → ready-for-human`)
      } catch (e) {
        ctx.log?.(`工单 ${issueRepo}#${issueNo} 改标签失败（不影响 PR）：${e?.message ?? e}`)
      }
    }
    // 立刻落库，控制台不用等下一轮同步。
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    ctx.log?.(`PR 建好 ${repo}#${number} ${pr.url ?? ""}（走 foreman）`)
    finishOperation(ctx, op, "success", `${repo}#${number} · ${pr.url ?? ""}`)
    return ok({
      repo, pr: number, url: pr.url ?? "", issue: issueNo || null, issueRepo: issueNo ? issueRepo : null,
      ui,
      acceptance,
    })
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
    // 自动化来源（--automation）：请求本身路由给 router agent 决策执行，不直接动手——
    // 默认调用者就是 agent，门禁提示也全部给 agent 自己消化。
    if (req.automation === true) {
      await routeToRouter(ctx, {
        type: "ws.add",
        text: [
          `【Foreman · 自动化请求】为工单 ${key} 开工作区（来源：自动化流程）。`,
          "请决策后自行执行 foreman ws add --repo " + (repoRef || repoCfg.repo) + " --issue " + key + "（不带 --automation）；不满足准入标签时先分流或说明原因。",
        ].join("\n"),
        json: { op: "ws.add", key, repo: repoCfg.repo },
      })
      ctx.log?.(`ws add ${key}：自动化请求已投 router`)
      return ok({ key, routed: "router", automation: true, worktree: "", branch: "" })
    }
    const book0 = new Book(ctx.cfg.stateFile)
    const rec0 = book0.issue(key)
    // 工单取一次：标签门禁、建档、右侧分支判断都用它。取不到且账本有档时降级继续（跳过门禁，记日志）。
    let issue = null
    try {
      issue = await ctx.gitea.viewIssue(String(m[1]), Number(m[2]))
    } catch (e) {
      if (!rec0) return fail("gitea-error", `账本里没有这条单，回查工单也失败：${String(e?.message ?? e).slice(0, 300)}`)
      ctx.log?.(`ws add ${key}：工单读取失败，跳过标签门禁（${String(e?.message ?? e).slice(0, 120)}）`)
    }
    // 标签门禁：只在「首次建分支」时把关（账本还没记过 branch）；补工作区/复用不重审（右侧分支回写照旧）。
    // 门禁放在建档之前：被拒的单不在账本留痕。组织级准入标签 5 个：ready-for-agent=可开工；
    // needs-triage=先分流；needs-info=先要信息；ready-for-human=归人工；wontfix=不修。
    // 其他标签（enhancement 等）不参与门禁。
    const firstTime = !rec0 || !String(rec0.branch ?? "").trim()
    if (firstTime && issue) {
      const labels = (Array.isArray(issue.labels) ? issue.labels : []).map((l) => String(l).toLowerCase())
      const has = (name) => labels.includes(name)
      if (!has("ready-for-agent") && req.force !== true) {
        if (has("wontfix")) {
          return fail("wontfix", `工单 ${key} 已标记 wontfix（不修），不建工作区。若判断应当修，先与负责人确认并摘掉 wontfix 标签再重试；或 --force 显式绕过。`)
        }
        if (has("ready-for-human")) {
          return fail("needs-human", `工单 ${key} 带 ready-for-human：归属人工处理，agent 不要开工。等人工处理完并调整标签后再重试；或 --force 显式绕过。`)
        }
        if (has("needs-info")) {
          return fail("needs-info", `工单 ${key} 带 needs-info：信息不足不能开工。请向用户/工单发起人索要缺失信息（foreman issue comment 留言或 send --type mail），信息齐了把标签改成 ready-for-agent 再重试 ws add；或 --force 显式绕过。`)
        }
        if (has("needs-triage")) {
          return fail(
            "needs-triage",
            `工单 ${key} 带 needs-triage：先调研再分流，不直接开工。请阅读工单与相关代码给出可行方案，然后改标签（ready-for-agent=可开工 / ready-for-human=交人工）再重试 ws add；拿不准就 foreman send --type mail 请用户决策。或 --force 显式绕过；自动化流程请改用 --automation 路由给 router。`,
          )
        }
        return fail("not-ready", `工单 ${key} 没有 ready-for-agent，未经确认不开工。人工确认后加该标签再重试；若你就是决策者，可 --force 显式绕过。`)
      }
    }
    let rec = rec0
    if (!rec && issue) {
      // 一条龙/noop 自起步：账本还没有这条单（从没 hand 过）时，按 tracker 工单建档成 planned，
      // 工作区链路就能独立于派单流程使用。不凭空造单。
      book0.setIssue(key, {
        state: "planned",
        issue: Number(m[2]),
        title: String(issue?.title ?? ""),
        url: String(issue?.url ?? ""),
        repo: String(m[1]),
        labels: Array.isArray(issue?.labels) ? issue.labels : [],
      })
      rec = book0.issue(key)
      ctx.log?.(`ws add ${key}：账本没有这条单，已按 tracker 工单建档（planned）`)
    }
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
    // worktree 就绪后跑 repos[].worktreeHook（装依赖等初始化）。warn-and-continue：
    // 失败不阻塞工作区交付，结果记进账本与返回 payload，coder 看得到并自救。
    const hook = await runWorktreeHooks(repoCfg, wt.path, ctx.log ?? (() => {}))
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
      hookOk: hook.ok,
      ...(hook.ok ? {} : { hookError: hook.error }),
    })
    // 更新工单右侧分支字段（Gitea Issue.ref）：只认工单所在仓库的那条工作区，值已对就不重写。
    // 走 tracker 适配器 + issueRef 能力位——GitHub/Jira 类没有这字段，自动跳过不报错。
    let branchRef = rec.branchRef ?? null
    const refOn = repoCfg.repo === keyRepo
      && typeof ctx.gitea?.editIssue === "function"
      && ctx.gitea?.capabilities?.issueRef !== false
    if (refOn && issue) {
      try {
        if (String(issue.ref ?? "") !== branch) {
          await ctx.gitea.editIssue(String(m[1]), Number(m[2]), { ref: branch })
          branchRef = { branch, at: nowIso() }
          ctx.log?.(`ws add ${key}：已指定工单右侧分支 ${branch}`)
        }
      } catch (e) {
        ctx.log?.(`ws add ${key}：工单右侧分支更新失败，工作区照常：${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
    book0.setIssue(key, {
      workspaces,
      repo: rec.repo || keyRepo,
      // 主仓库那条老字段保持原样：没有才补，别让后加的工程覆盖掉。
      ...(rec.branch ? {} : { branch: prev?.branch || workspaces[0]?.branch || branch }),
      ...(rec.worktree ? {} : { worktree: workspaces[0]?.worktree || wt.path }),
      ...(branchRef ? { branchRef } : {}),
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
      hook: { ok: hook.ok, ...(hook.ok ? {} : { error: hook.error }) },
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
    // 没建档 ≠ 出错：一条龙/noop 下工单可能还没开过工作区，回空清单。
    if (!rec) return ok({ key, workspaces: [], prs: [] })
    return ok({
      key,
      workspaces: (rec.workspaces ?? []).map((w) => ({ repo: w.repo, branch: w.branch, worktree: w.worktree })),
      prs: (rec.prs ?? []).map((p) => ({ repo: p.repo, pr: p.pr, prUrl: p.prUrl, branch: p.branch })),
    })
  }

  // ---- 以工单绑定的编排会话为中心（每单独立编排 → 派单 → steer 回本单编排 → merge → clean）----

  // orch show：整条链路现在绑在哪条会话上、最近 steer 了什么。
  if (cmd === "orch show") {
    const book = new Book(ctx.cfg.stateFile)
    const target = orchestratorTarget(book)
    const workers = Object.entries(book.issues ?? {})
      .filter(([, it]) => String(it?.agentConvId ?? "").trim())
      .map(([key, it]) => ({
        issueKey: key,
        state: String(it?.state ?? ""),
        agent: String(it?.agent ?? ""),
        convId: String(it?.agentConvId ?? ""),
        orchestrator: String(it?.orchestrator ?? ""),
      }))
    return ok({
      enabled: sessionFlowEnabled(ctx.cfg),
      orchestrator: orchestratorInfo(book),
      bound: !!target,
      // 自动接单：工作会话绑到这张单自己的编排会话（issues[键].orchestrator）。
      // 用户自主发起：工作会话绑到发起方那条会话（initiators 里按 convId 分组）。
      initiators: boundInitiators(book),
      workers,
      steers: (book.steers[target] ?? []).slice(-5),
    })
  }

  // hand：把一张工单交给编排会话（首句含编排职责与工单，账本记 handed）。不建工作区、不开工作会话。
  // hand：把工单投给 router agent（唯一编排者），不再直接开编排会话。
  if (cmd === "hand") {
    const ref = String(req.issue ?? "").trim()
    const m = ref.match(/([^#\s]+)#([0-9]+)$/)
    if (!m) return fail("bad-request", `hand 的 --issue 要写成 <owner/name>#<工单号>，收到：${ref || "（空）"}`)
    const repoCfg = findRepoCfg(ctx.cfg, m[1])
    if (!repoCfg) return fail("bad-request", `配置里没有这个工程：${m[1]}`)
    const number = Number(m[2])
    let issue
    try {
      issue = { ...(await ctx.gitea.viewIssue(repoCfg.repo, number)), number }
    } catch (e) {
      return fail("gitea-error", `读不到工单 ${repoCfg.repo}#${number}：${e.message}`)
    }
    try {
      return ok(await routeIssueToRouter(ctx, { repoCfg, issue, via: "hand" }))
    } catch (e) {
      return fail("hand-failed", e.message)
    }
  }

  // clean：合并关单之后清残留 worktree、本地分支、工作会话与监听（幂等，重复调没副作用）。
  if (cmd === "clean") {
    // 调用方会话 id（编排会话自己就是发起方）：clean 要归档这张单的编排会话，
    // 但绝不能归档正在执行这条命令的那条——那种情况留给服务的下一轮收。
    const currentConv = String(req.orchestrator ?? "").trim()
    if (req.all === true && !String(req.issue ?? "").trim()) {
      const keys = cleanableIssues(new Book(ctx.cfg.stateFile))
      const notes = []
      for (const key of keys) {
        const r = await cleanIssue(ctx, { issueKey: key, currentConv })
        if (r.notes?.length) notes.push(`[${key}] ${r.notes.join("；")}`)
      }
      try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
      ctx.log?.(`clean --all：清了 ${keys.length} 条单`)
      if (keys.length) kickPickup(ctx, "clean --all")
      return ok({ cleaned: keys.length, keys, notes })
    }
    const ref = String(req.issue ?? "").trim()
    const m = ref.match(/([^#\s]+)#([0-9]+)$/)
    if (!m) return fail("bad-request", "clean 需要 --issue <owner/name>#<工单号>（或 --all）")
    // 远程/本地拆分：显式给了 --remote/--local 才限定范围，缺省两部都跑。
    const hasScope = req.remote !== undefined || req.local !== undefined
    const scope = {
      remote: hasScope ? req.remote === true : true,
      local: hasScope ? req.local === true : true,
    }
    if (!scope.remote && !scope.local) return fail("bad-request", "--remote / --local 至少要选一个")
    const out = await cleanIssue(ctx, { issueKey: `${m[1]}#${Number(m[2])}`, currentConv, ...scope })
    if (!out.ok) {
      return fail(
        out.reason === "pr-not-merged" ? "pr-not-merged" : "bad-request",
        out.reason === "pr-not-merged"
          ? `${out.notes[0] ?? "还有 PR 没合并"}（先 foreman pr merge，全合完再 clean --remote）`
          : `账本里没有这条单：${m[1]}#${m[2]}`,
      )
    }
    ctx.log?.(`clean ${out.issueKey}：${out.notes.join("；") || "没有要清的"}（scope ${scope.remote ? "远程" : ""}${scope.remote && scope.local ? "+" : ""}${scope.local ? "本地" : ""}）`)
    // 收尾即完成：立刻补下一张，不用等巡检 cron（编排合完调 clean 就是这条路径）。
    if (["done", "cleaned"].includes(String(new Book(ctx.cfg.stateFile).issue(out.issueKey)?.state ?? ""))) {
      kickPickup(ctx, `${out.issueKey} clean 收尾`)
    }
    return ok({ ...out, scope: out.scope ?? { remote: true, local: true } })
  }

  if (cmd === "pr merge") {
    const startedAt = Date.now()
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
        // UI 验收：--ui 声明这条 PR 改了界面；--approved-by <人> 表示人已经当面验收过了（用户回「合并」）。
        ui: req.ui === true,
        approvedBy: String(req.approvedBy ?? "").trim(),
      })
    let result
    try {
      const prev = ctx.mergeChain ?? Promise.resolve()
      const mine = prev.then(run, run)
      ctx.mergeChain = mine.then(() => {}, () => {})
      result = await mine
    } catch (e) {
      return { ...fail("merge-failed", String(e?.message ?? e)), repo, number, elapsedMs: Date.now() - startedAt }
    }
    if (!result?.ok) {
      // 验收闸门挡住时把原因原样回给调用方（acceptance-waiting / acceptance-rejected），
      // 编排看到这两个码就知道该等邮件回复，而不是重试合并。
      const code = ["acceptance-waiting", "acceptance-rejected"].includes(String(result?.reason ?? ""))
        ? String(result.reason)
        : "merge-failed"
      return {
        ...fail(code, result?.message ?? result?.reason ?? "未知原因"),
        repo, number, elapsedMs: Date.now() - startedAt,
        gate: result?.gate ?? null,
      }
    }
    // 合并成功后把账本里的待合并条目收掉，避免再合一遍。
    try { new Book(ctx.cfg.stateFile).dropMerge(key) } catch {}
    // 合并-only：不再当场归档通知会话（收尾归 clean）。
    const notes = [...(result.notes ?? [])]
    // 同步回包：调用方（编排会话）拿到的这一条就是合并结论，不用等任何后续消息。
    // 关单事实按账本判定（close 节点会把工单置 done；多工程还有 PR 没合时先不关）。
    const bookM = new Book(ctx.cfg.stateFile)
    const issueKeyOut = String(result.issueKey ?? "") || (issueNo ? `${repo}#${issueNo}` : "")
    const issueState = issueKeyOut ? String((bookM.issue(issueKeyOut) ?? {}).state ?? "") : ""
    const closed = ["done", "cleaned"].includes(issueState)
    const worktree = String(result?.worktree ?? "")
    const where = `工程 ${repo} · worktree ${worktree || "无"}`
    const elapsedMs = Date.now() - startedAt
    const awaitingClean = issueKeyOut ? !closed : false
    const summary =
      `${result.alreadyMerged ? "原本已合并" : "已合并"} ${repo}#${number}` +
      (issueKeyOut ? `，工单 ${issueKeyOut} ${closed ? "已关单" : "待 clean 关单收尾"}` : "，无关联工单") +
      (notes.length ? `；收尾：${notes.join("；")}` : "")
    ctx.log?.(`已合并 ${repo}#${number}${issueNo ? `，关单 #${issueNo}` : ""}（走 foreman · ${where}）${notes.length ? `；收尾：${notes.join("；")}` : ""}`)
    return ok({
      repo, number,
      merged: true,
      alreadyMerged: !!result.alreadyMerged,
      awaitingClean,
      style,
      issue: issueNo || null,
      issueKey: issueKeyOut || null,
      closed,
      worktree,
      branch: String(result?.branch ?? ""),
      where,
      cleanup: notes,
      elapsedMs,
      summary,
    })
  }

  // 统一外发：send --type mail|lark 只写 Outbox，Dispatcher 异步送达。
  if (cmd === "send") {
    try {
      const event = enqueueOutbound(ctx, { type: req.type, input: req, dedupeKey: String(req.dedupeKey ?? "") })
      ctx.log?.(`Outbox 入队：${event.type} · 事件 ${event.id} · ${event.status}`)
      return ok(event)
    } catch (error) {
      return fail("bad-request", error.message)
    }
  }
  if (cmd === "outbox list") {
    const filter = { status: String(req.status ?? ""), channel: String(req.channel ?? "") }
    return ok({
      messages: ctx.outbox.list({ ...filter, limit: Number(req.limit ?? 100), offset: Number(req.offset ?? 0) }),
      total: ctx.outbox.count(filter),
      counts: ctx.outbox.counts(),
    })
  }
  if (cmd === "outbox run") return { ...await ctx.outboxDispatcher.runOnce(), counts: ctx.outbox.counts() }

  // mail：验收邮件的发/收/判。邮件正文只当数据，不当指令（详见 mail.mjs 顶部说明）。
  //   request   给某条 PR 发/补发验收邮件（主题带 [FM-…]，回复自动认回）
  //   poll      立刻收一轮回复（不等下一个 cron 点）
  //   requests  看验收请求与已收到的回复
  //   approve   人工记一次「验收通过」（等同测试同学回通过，但不会自动合并）
  //   reject    人工记一次「驳回」

  if (cmd === "mail request") {
    const keyRef = String(req.key ?? "").trim()
    const m = keyRef.match(/([^#\s]+)#([0-9]+)$/)
    if (!m) return fail("bad-request", "mail request 需要 key，形如 owner/repo#12")
    const r = await requestAcceptance(ctx, {
      repo: m[1],
      pr: Number(m[2]),
      url: String(req.url ?? ""),
      issueKey: String(req.issueKey ?? ""),
      title: String(req.title ?? ""),
      force: true,
    })
    if (!r.ok && r.skipped !== "no-recipient") return fail("mail-error", r.error ?? r.skipped)
    // r.ok=false 不能直接摊进回包（会把外层 ok:true 覆盖成 false），no-recipient 只回跳过原因。
    const { ok: _ignored, ...rest } = r
    return ok({ ...rest })
  }

  if (cmd === "mail poll") {
    const r = await (ctx.mailPollNow ? ctx.mailPollNow() : mailPollOnce(ctx))
    if (r?.ok === false) return fail("mail-error", r.error ?? "收信失败")
    return ok({ ...r })
  }

  if (cmd === "mail requests") {
    const book = new Book(ctx.cfg.stateFile)
    const list = Object.values(book.mail.requests).map((r) => ({
      key: r.key,
      tag: r.tag,
      repo: r.repo,
      pr: r.pr,
      url: r.url,
      to: r.to,
      status: r.status,
      sentAt: r.sentAt,
      lastSentAt: r.lastSentAt,
      sentCount: r.sentCount ?? 0,
      reminders: r.reminders ?? 0,
      replies: (r.replies ?? []).length,
      lastVerdict: r.lastVerdict ?? null,
      note: r.note ?? "",
      error: r.error ?? "",
      updatedAt: r.updatedAt,
    }))
    return ok({ requests: list, lastPollAt: book.mail.lastPollAt ?? "", rr: book.mail.rr ?? 0 })
  }

  if (cmd === "mail approve" || cmd === "mail reject") {
    const keyRef = String(req.key ?? "").trim()
    const m = keyRef.match(/([^#\s]+)#([0-9]+)$/)
    if (!m) return fail("bad-request", `${cmd} 需要 key，形如 owner/repo#12`)
    const key = `${m[1]}#${Number(m[2])}`
    const book = new Book(ctx.cfg.stateFile)
    const by = String(req.by ?? "").trim() || "人工"
    const note = String(req.note ?? "").trim()
    if (cmd === "mail reject") {
      book.markMailRequest(key, {
        status: "rejected",
        lastReplyAt: nowIso(),
        lastVerdict: { verdict: "rejected", from: by, summary: note || "人工驳回", messageId: "" },
      })
      ctx.log?.(`验收驳回（人工）：${key} · ${by}${note ? ` · ${note}` : ""}`)
      return ok({ key, status: "rejected", by })
    }
    book.markApproval(key, { by, via: "user", note: note || "人工验收通过" })
    book.markMailRequest(key, {
      status: "approved",
      lastReplyAt: nowIso(),
      lastVerdict: { verdict: "approved", from: by, summary: note || "人工验收通过", messageId: "" },
    })
    ctx.log?.(`验收通过（人工）：${key} · ${by}${note ? ` · ${note}` : ""}`)
    return ok({ key, status: "approved", by })
  }

  // issue create：一条龙的起点——tracker 建单 + 账本建档（planned）。之后 ws add / pr open / pr merge
  // 都认这个键。tracker 是适配器：换 GitHub/Jira 时实现各自 createIssue 即可，本段不感知差异。
  if (cmd === "issue create") {
    const repo = String(req.repo ?? "").trim()
    const title = String(req.title ?? "").trim()
    const body = String(req.body ?? "")
    if (!repo || !title) return fail("bad-request", "issue create 需要 repo 与 title")
    if (typeof ctx.gitea?.createIssue !== "function") return fail("not-supported", "当前 tracker 适配器不支持建单")
    let issue
    try {
      issue = await ctx.gitea.createIssue(repo, { title, body })
    } catch (e) {
      return fail("gitea-error", `建单失败：${e.message}`)
    }
    const number = Number(issue?.number ?? 0)
    if (!number) return fail("gitea-error", "建单返回缺少工单号")
    const key = `${repo}#${number}`
    new Book(ctx.cfg.stateFile).setIssue(key, {
      state: "planned",
      issue: number,
      title: String(issue?.title ?? title),
      url: String(issue?.url ?? ""),
      repo,
    })
    ctx.log?.(`issue create ${key}：${issue?.url ?? ""}`)
    return ok({ key, number, title: String(issue?.title ?? title), url: String(issue?.url ?? "") })
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

  if (cmd === "issue settle") {
    const repo = String(req.repo ?? "").trim()
    const number = Number(req.number ?? 0)
    const note = String(req.note ?? "").trim()
    if (!repo || !number) return fail("bad-request", "issue settle 需要 repo / number")
    if (!note) return fail("bad-request", "issue settle 必须用 --note 写明完成依据")
    const key = `${repo}#${number}`
    const book = new Book(ctx.cfg.stateFile)
    if (!book.issue(key)) return fail("bad-request", `账本里没有这条单：${key}`)
    book.setIssue(key, {
      state: "done",
      settledAt: nowIso(),
      settledBy: "router",
      settleNote: note.slice(0, 1000),
    })
    ctx.consoleStore?.event({ kind: "issue_settled", key, repo, number, detail: note.slice(0, 200) })
    try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
    ctx.log?.(`router agent本地完成 ${key}：${note}（不关远端、不清工作区）`)
    return ok({ key, state: "done", remoteClosed: false, workspaceCleaned: false })
  }

  if (cmd === "issue complete") {
    const repo = String(req.repo ?? "").trim()
    const number = Number(req.number ?? 0)
    const out = await completeIssue(ctx, { repo, number })
    if (!out.ok) return fail(out.error ?? "complete-failed", out.message ?? "手动完成失败")
    return ok(out)
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
    const bookNow = new Book(ctx.cfg.stateFile)
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
      inbox: {
        counts: ctx.inbox?.counts() ?? {},
        schedules: ctx.inbox?.schedules() ?? [],
        worker: {
          running: ctx.inboxWorker?.running === true,
          runCount: Number(ctx.inboxWorker?.runCount ?? 0),
          lastResult: ctx.inboxWorker?.lastResult ?? null,
        },
      },
      logFile: ctx.cfg.service.logFile,
      http: ctx.httpUrl || "",
      port: ctx.state.port ?? null,
      portFile: ctx.cfg.service?.http?.portFile ?? "",
      workHours: {
        config: ctx.cfg.workHours ?? null,
        active: inWorkHours(ctx.cfg),
        now: nowIso(),
      },
      feishu: ctx.feishu
        ? { ...(ctx.feishu.view?.() ?? { enabled: true, running: true }), replyPump: ctx.feishuPump?.lastResult ?? null }
        : {
            enabled: ctx.cfg.feishu?.enabled === true,
            running: false,
            ...(ctx.feishuError ? { error: ctx.feishuError } : {}),
          },
      deliver: {
        mode: deliveryMode(ctx.cfg),
        promptFile: ctx.cfg.deliver?.promptFile ?? "",
        projectDir: ctx.cfg.deliver?.projectDir ?? "",
        waitFirstReply: ctx.cfg.deliver?.waitFirstReply === true,
      },
      pickup: {
        auto: false,
        legacyAutoConfigured: ctx.cfg.pickup?.auto === true,
        intervalSeconds: ctx.cfg.pickup?.intervalSeconds,
        maxPerRound: ctx.cfg.pickup?.maxPerRound,
        maxRunning: ctx.cfg.pickup?.maxRunning,
        // 收口自动补单已移除；旧配置仅保留兼容读取，不产生影响。
        kickAfterDone: false,
        kickPending: false,
        inflight: inflightIssues(new Book(ctx.cfg.stateFile)).length,
        lastAt: ctx.state.pickup?.lastAt ?? null,
        count: ctx.state.pickup?.count ?? 0,
        running: ctx.state.pickup?.running === true,
        lastResult: ctx.state.pickup?.lastResult ?? null,
      },
      // 以工单绑定的编排会话为中心：自动接单每单独立编排；用户自主发起的单把调用方会话绑成它的编排。
      // 每条单的更新都 steer 进它自己绑的那条（issues[键].orchestrator）。
      sessionFlow: {
        enabled: sessionFlowEnabled(ctx.cfg),
        orchestrator: orchestratorInfo(new Book(ctx.cfg.stateFile)),
        bound: Object.values(new Book(ctx.cfg.stateFile).issues ?? {}).filter((it) => String(it?.agentConvId ?? "").trim()).length,
        initiators: boundInitiators(new Book(ctx.cfg.stateFile)),
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
        // 合并通道已取消：只剩「还有几条待合并的 PR」，由合并助手直接调 pr merge。
        queued: Object.values(new Book(ctx.cfg.stateFile).mergeQueue ?? {}).filter((t) => String(t.status ?? "queued") === "queued").length,
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
      router: {
        ...(new Book(ctx.cfg.stateFile).data.router ?? new Book(ctx.cfg.stateFile).data.inspector ?? {}),
        running: ctx.state.router?.running === true,
        nextAt: ctx.state.router?.nextAt ?? "",
      },
      // 旧控制台字段兼容；新调用方读取 router。
      inspector: {
        ...(new Book(ctx.cfg.stateFile).data.router ?? new Book(ctx.cfg.stateFile).data.inspector ?? {}),
        running: ctx.state.router?.running === true,
        nextAt: ctx.state.router?.nextAt ?? "",
      },
      // 验收邮件：testers 还是占位符时 recipients=[]，此时不挡合并（沿用人工验收）。
      mail: {
        enabled: ctx.cfg.mail?.enabled === true,
        uiGate: ctx.cfg.mail?.uiGate !== false,
        bin: ctx.cfg.mail?.bin ?? "agently-cli",
        testers: ctx.cfg.mail?.testers ?? [],
        recipients: realRecipients(ctx.cfg),
        strategy: ctx.cfg.mail?.strategy ?? "round-robin",
        pollSeconds: ctx.cfg.mail?.pollSeconds ?? 300,
        remindMinutes: ctx.cfg.mail?.remindMinutes ?? 0,
        maxReminders: ctx.cfg.mail?.maxReminders ?? 0,
        lastPollAt: ctx.state.mail?.lastPollAt ?? null,
        pollCount: ctx.state.mail?.pollCount ?? 0,
        lastResult: ctx.state.mail?.lastResult ?? null,
        nextAt: ctx.state.mail?.nextAt ?? "",
        polling: ctx.state.mail?.polling === true,
        waiting: Object.values(bookNow.mail.requests).filter((r) => String(r?.status ?? "") === "waiting").length,
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
      parent: String(req?.orchestrator ?? ""),
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

  if (cmd === "pr ui-assign") {
    return prUiAssignOnce(ctx, { repo: String(req.repo ?? "").trim(), number: Number(req.number ?? 0) || 0 })
  }

  if (cmd === "pr assign") {
    const r = await prAssignOnce(ctx, req)
    if (!r.ok) return fail(r.error || "pr-assign-failed", r.message || "PR 分配失败")
    return ok(r)
  }

  if (cmd === "pr poll") {
    const r = await ctx.prPoll()
    return ok(r)
  }

  if (cmd === "chat send") {
    if (!ctx.chat) return fail("chat-unavailable", "Chat 不在当前服务里")
    return ok(await ctx.chat.send(req))
  }

  if (cmd === "chat messages") {
    if (!ctx.chat) return fail("chat-unavailable", "Chat 不在当前服务里")
    return ok(await ctx.chat.messages())
  }

  if (cmd === "chat messagesFor") {
    if (!ctx.chat) return fail("chat-unavailable", "Chat 不在当前服务里")
    if (typeof ctx.chat.messagesFor !== "function") return fail("chat-unavailable", "当前 chat 不支持按会话读取")
    return ok(await ctx.chat.messagesFor(req.target))
  }

  if (cmd === "chat clear") {
    if (!ctx.chat) return fail("chat-unavailable", "Chat 不在当前服务里")
    if (typeof ctx.chat.clear !== "function") return fail("chat-unavailable", "当前 chat 不支持 /clear")
    try {
      return ok(await ctx.chat.clear())
    } catch (e) {
      return fail(e.code || "chat-clear-failed", e.message)
    }
  }

  if (cmd === "chat archive") {
    if (!ctx.chat) return fail("chat-unavailable", "Chat 不在当前服务里")
    if (typeof ctx.chat.archive !== "function") return fail("chat-unavailable", "当前 chat 不支持归档")
    try {
      return ok(await ctx.chat.archive(req))
    } catch (e) {
      return fail(e.code || "chat-archive-failed", e.message)
    }
  }

  if (cmd === "inbox list") {
    const status = String(req.status ?? "")
    return ok({
      events: ctx.inbox?.list({ limit: Number(req.limit ?? 100), offset: Number(req.offset ?? 0), status }) ?? [],
      total: ctx.inbox?.count({ status }) ?? 0,
      schedules: ctx.inbox?.schedules() ?? [],
      counts: ctx.inbox?.counts() ?? {},
    })
  }

  if (cmd === "worker run") {
    if (typeof ctx.inboxWorker?.runOnce !== "function") return fail("worker-unavailable", "Worker 不在当前服务里")
    const r = await ctx.inboxWorker.runOnce()
    return ok(r)
  }

  if (["route", "router", "inspect"].includes(cmd)) {
    const r = typeof ctx.router === "function" ? await ctx.router() : await routerOnce(ctx, { force: true })
    if (!r.ok) return fail("router-failed", r.error || "router agent 投递失败")
    return ok(r)
  }

  // 手动催一轮候选处理；自动定时接单已移除，调用方通常是router agent。
  if (cmd === "pickup") {
    const r = await ctx.pickup({ force: true })
    return ok(r)
  }

  // run：扫描一轮可接工单，逐条投 router（不再直接派会话）。--dry-run 只打印计划。
  if (cmd === "run") {
    const lockFile = path.join(path.dirname(ctx.cfg.stateFile), "run.lock")
    const lock = acquireLock(lockFile)
    if (!lock) return ok({ ok: true, skipped: "locked" })
    try {
      const handled = await runRound({
        cfg: ctx.cfg,
        book: new Book(ctx.cfg.stateFile),
        dws: ctx.dws,
        log: ctx.log,
        consoleStore: ctx.consoleStore,
        engine: ctx.engine,
        only: String(req.only ?? "").trim(),
        dryRun: req.dryRun === true,
        routeIssue: (args) => routeIssueToRouter(ctx, args),
      })
      try { ctx.consoleStore?.sync(new Book(ctx.cfg.stateFile)) } catch {}
      return ok({ ok: true, handled })
    } catch (e) {
      return fail(e.code === "app_unavailable" ? "app_unavailable" : "run-failed", e.message)
    } finally {
      releaseLock(lockFile)
    }
  }

  if (cmd === "pr list") {
    const book = new Book(ctx.cfg.stateFile)
    return ok({
      target: prWatchTarget(ctx.cfg, book),
      prs: Object.entries(book.prSeen).map(([key, v]) => ({ key, ...v })),
    })
  }

  if (cmd === "stop") {
    // 先回响应，再收口退出。close 会清定时器/worker/http 与 pid/port 文件；
    // serve 进程（FOREMAN_SERVE 标记，cmdServe 设置）收口完成后自行退出——
    // 测试/库调用没有这个标记，只 close 不退进程。
    setTimeout(() => ctx.close?.().catch(() => {}), 10)
    const exitAt = setTimeout(() => {
      if (process.env.FOREMAN_SERVE === "1") process.exit(0)
    }, 3000)
    exitAt.unref?.()
    return ok({ stopping: true, pid: process.pid })
  }

  return fail("unknown_cmd", `未知命令：${cmd || "(空)"}`)
}

export { pingOnce }
