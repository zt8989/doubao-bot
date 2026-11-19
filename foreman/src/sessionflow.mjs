// 以工单绑定的编排会话为中心：自动巡检每张工单各起一条编排智能体会话，工作会话绑在它身上。
//
// 与老模型的区别（老：每次收工新建「派单/合并」会话、由服务通知）：
//   - 自动巡检按工单起编排会话（ensureIssueOrchestrator 幂等），编排职责与工单合进首句，后续更新用 dws msg --mode steer；
//   - 用户从当前会话主动派单时，当前会话直接作为这张单的编排，不另起；
//   - 工单先交给自己的编排（hand），由编排调 `foreman dispatch` 分配工作；
//   - 工作会话 id 写进账本 issues[<键>] 的 agent / agentConvId / orchestrator；
//   - 工作会话失败用 `foreman resume` 在**同一条**工作会话里 steer 续跑，绝不新开；
//   - PR 扫描独立走 deliver.mode=new，新建合并会话，不复用任何工单编排会话；
//   - 合并关单之后 `foreman clean` 清 worktree、工作会话与这张单自己的编排会话；
import fs from "node:fs"
import { Book } from "./book.mjs"
import { builtinPrompt } from "./builtin-prompts.mjs"
import { nowIso, expandHome } from "./util.mjs"
import { resume } from "./prompts.mjs"
import { git, worktreeRemove, statusPorcelain } from "./gitx.mjs"
import * as realGitea from "./gitea.mjs"

// 开关：只有显式 sessionFlow.enabled === true 才走会话中心（loadConfig 的默认值是 true；
// 测试与老调用手搓 cfg 时没有这一段，仍走老的直接派单，行为不变）。
export function sessionFlowEnabled(cfg) {
  return cfg?.sessionFlow?.enabled === true
}

export function orchestratorName(cfg) {
  const explicit = String(cfg?.sessionFlow?.name ?? "").trim()
  if (explicit) return explicit
  return `${String(cfg?.deliver?.namePrefix ?? "").trim() || "foreman"}-编排`
}

// 自动巡检的编排会话按工单命名，和该单的工作会话区分开，也方便在侧边栏直接认单。
export function issueOrchestratorName(cfg, issueKey = "") {
  const prefix = String(cfg?.deliver?.namePrefix ?? "").trim() || "foreman"
  const key = String(issueKey ?? "").trim()
  const match = key.match(/^([^#\s]+)#([0-9]+)$/)
  if (!match) return `${prefix}-编排`
  const repoName = match[1].split("/").filter(Boolean).at(-1) || "issue"
  return `${prefix}-${repoName}-${match[2]}-编排`
}

// 工单收口（已合并/已关单）后编排会话就没有下一件事了，这两个状态算终端态。
export const TERMINAL_ISSUE_STATES = ["done", "cleaned"]

// 这张单的编排会话是不是 foreman 自己为它建的（而不是调用方/用户自己的会话）。
// 判据只看账本：sessions 里 kind=orchestrator 且 issueKey 正好是这张单。
// 全局编排（book.orchestrator，没有 issueKey）与用户发起方会话都不满足——反过来，
// 拿这个函数当地址簿，就不会误归档用户自己的对话。
export function ownedIssueOrchestrator(book, issueKey = "") {
  const key = String(issueKey ?? "").trim()
  if (!key) return null
  for (const [name, s] of Object.entries(book?.sessions ?? {})) {
    if (String(s?.kind ?? "") !== "orchestrator") continue
    if (String(s?.issueKey ?? "") !== key) continue
    const convId = String(s?.convId ?? "").trim()
    if (!name && !convId) continue
    return { name: String(name), convId }
  }
  return null
}

// 顶层全局编排只保留给手工 `foreman orch start` 的兼容入口；自动流程不再使用它。
export function orchestratorTarget(book) {
  return String(book?.data?.orchestrator?.convId ?? "").trim()
}

export function orchestratorInfo(book) {
  return { ...(book?.data?.orchestrator ?? { convId: "", name: "", at: "" }) }
}

// 编排提示词：配置给了 promptFile 就读那份（读不到直接报错，不悄悄退回内置），否则用内置的。
function orchestratorBasePrompt(cfg) {
  const file = String(cfg?.sessionFlow?.promptFile ?? "").trim()
  if (!file) return builtinPrompt("orchestrator")
  const text = fs.readFileSync(expandHome(file), "utf8")
  if (!text.trim()) throw new Error(`编排提示词是空文件：${file}`)
  return text
}

export function orchestratorPrompt(ctx = {}, { issueKey = "", issue = null } = {}) {
  const cfg = ctx.cfg ?? {}
  const projectDir = String(cfg.sessionFlow?.projectDir ?? cfg.deliver?.projectDir ?? "").trim()
  const base = String((cfg.repos ?? [])[0]?.base ?? "").trim()
  const lines = [orchestratorBasePrompt(cfg).trim(), "", "---", ""]
  if (projectDir) lines.push(`监控项目：${projectDir}`)
  lines.push("通道：派单（agent 主动 dispatch 不限在跑上限；pickup.maxRunning 只约束定时巡检）")
  if (base) lines.push(`基线：origin/${base}`)
  if (issueKey) {
    lines.push(`绑定工单：${issueKey}${issue?.title ? ` ${issue.title}` : ""}`)
    lines.push("你只编排这一张工单；这张单后续的工作会话更新都会 steer 到本会话。")
  } else {
    lines.push("工单会 steer 进这条会话（正文带「工单键」）；实现只在工作会话里，你不写代码。")
  }
  return lines.join("\n")
}

// 起/复用唯一编排会话。幂等：账本里已有 convId 就直接复用，绝不新开第二条。
export async function ensureOrchestrator(ctx, { name = "" } = {}) {
  const { cfg, dws, log = () => {} } = ctx
  const book = new Book(cfg.stateFile)
  const prev = book.data.orchestrator ?? {}
  const convId = String(prev.convId ?? "").trim()
  if (convId) return { ok: true, reused: true, created: false, convId, name: String(prev.name ?? "") }

  if (typeof dws?.openNew !== "function") {
    throw Object.assign(new Error("会话适配器没有 openNew，起不了编排会话"), { code: "no-session-adapter" })
  }
  const nm = String(name ?? "").trim() || orchestratorName(cfg)
  const prompt = orchestratorPrompt(ctx)
  const noWait = cfg?.sessionFlow?.waitFirstReply !== true
  const out = await dws.openNew({ name: nm, prompt, noWait })
  const newConvId = String(out?.convId ?? "").trim()
  book.setOrchestrator({ convId: newConvId, name: nm })
  book.record(nm, { convId: newConvId, kind: "orchestrator", role: "orchestrator", notify: false })
  log(
    `编排会话就绪：${nm}${newConvId ? `（${newConvId}）` : "（没拿到会话 id，工作会话的更新送不进来；用 foreman orch show 核对）"}`
  )
  return { ok: true, reused: false, created: true, convId: newConvId, name: nm }
}

// 一张自动巡检工单一条编排会话。hand 时把编排职责和工单合进首句，一次发出；
// 已有绑定直接复用，不重复开会话，也不再 steer 工单。
export async function ensureIssueOrchestrator(ctx, { issueKey, repoCfg = null, issue = null, withTicket = false, fresh = false } = {}) {
  const { cfg, dws, log = () => {} } = ctx
  const key = String(issueKey ?? "").trim()
  if (!key) throw new Error("issueKey 不能为空，无法绑定工单编排会话")
  const book = new Book(cfg.stateFile)
  const prev = book.issue(key) ?? {}
  const existing = String(prev.orchestrator ?? "").trim()
  if (existing && !fresh) {
    const name = Object.entries(book.sessions ?? {}).find(([, s]) => String(s?.convId ?? "") === existing)?.[0]
      || issueOrchestratorName(cfg, key)
    return { ok: true, reused: true, created: false, convId: existing, name }
  }
  if (typeof dws?.openNew !== "function") {
    throw Object.assign(new Error("会话适配器没有 openNew，起不了工单编排会话"), { code: "no-session-adapter" })
  }

  const name = fresh
    ? `${issueOrchestratorName(cfg, key)}-重派-${nowIso().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`
    : issueOrchestratorName(cfg, key)
  let prompt = orchestratorPrompt(ctx, { issueKey: key, issue })
  if (withTicket) {
    if (!repoCfg?.repo) throw new Error("合并编排与工单首句时缺 repoCfg.repo")
    prompt = `${prompt}\n\n---\n\n${ticketText({ repo: repoCfg.repo, issue, fresh })}`
  }
  const noWait = cfg?.sessionFlow?.waitFirstReply !== true
  const out = await dws.openNew({ name, prompt, noWait })
  const convId = String(out?.convId ?? "").trim()
  if (!convId) throw new Error(`工单编排会话 ${name} 没返回会话 id，不能安全绑定`)
  const number = Number(key.split("#")[1] ?? 0) || null
  book.setIssue(key, {
    repo: String(repoCfg?.repo ?? prev.repo ?? key.split("#")[0]),
    issue: number,
    title: String(issue?.title ?? prev.title ?? ""),
    url: String(issue?.url ?? prev.url ?? ""),
    orchestrator: convId,
  })
  book.record(name, {
    convId,
    kind: "orchestrator",
    role: "orchestrator",
    notify: false,
    issue: number,
    issueKey: key,
  })
  log(`${key}：已新建独立编排会话 ${name}`)
  return { ok: true, reused: false, created: true, convId, name }
}

// 一张单的后续更新只认单上绑定的编排会话；没有绑定就停住，不再错投到全局编排。
export function orchestratorOf(book, issueKey = "", fallback = "") {
  const own = String(book?.issue?.(String(issueKey ?? ""))?.orchestrator ?? "").trim()
  return own || String(fallback ?? "").trim()
}

// 往编排会话里插一条（dws msg --mode steer：Command+Enter，不打断它当前那一轮）。
// target 给了就用它（单上绑的编排 / 调用方会话），没给才用全局编排会话。
export async function steerOrchestrator(ctx, text, { kind = "", target = "" } = {}) {
  const cfg = ctx?.cfg ?? {}
  const book = new Book(cfg.stateFile)
  const to = String(target ?? "").trim() || orchestratorTarget(book)
  if (!to) return { ok: false, reason: "no-orchestrator" }
  const body = String(text ?? "").trim()
  if (!body) return { ok: false, reason: "empty" }
  if (typeof ctx.dws?.steer !== "function") return { ok: false, reason: "no-steer" }
  await ctx.dws.steer(to, body)
  book.clearIdle(to)
  book.clearGone(to)
  book.markSteer(to, { kind, chars: body.length })
  ctx.log?.(`已 steer 进编排会话${kind ? `（${kind}）` : ""}：${body.split("\n")[0].slice(0, 80)}`)
  return { ok: true, convId: to }
}

// 账本里这条单绑的工作会话：agent（会话名）+ agentConvId + 绑定时记的 orchestrator。
export function workerOf(book, issueKey) {
  const rec = book?.issue?.(issueKey) ?? null
  const name = String(rec?.agent ?? "").trim()
  const convId = String(rec?.agentConvId ?? "").trim() || String(book?.sessions?.[name]?.convId ?? "").trim()
  return { name, convId, orchestrator: String(rec?.orchestrator ?? "").trim() }
}

// 当前编排会话派出去的全部会话：dispatch 的主工作会话 + watch add 登记的补派会话。
// 老 watch 记录没有 parent，按它关联工单的 orchestrator 兜底；同一会话派多次只返回一条。
export function delegatedSessions(book, orchestrator) {
  const parent = String(orchestrator ?? "").trim()
  if (!parent) return []
  const rows = new Map()
  const add = ({ name = "", convId = "", issueKey = "", state = "", source = "" } = {}) => {
    name = String(name ?? "").trim()
    convId = String(convId ?? "").trim()
    const key = convId || name
    if (!key || key === parent) return
    const prev = rows.get(key) ?? { name: "", convId: "", issueKey: "", state: "", issueKeys: [], sources: [] }
    const issue = String(issueKey ?? "").trim()
    rows.set(key, {
      name: name || prev.name,
      convId: convId || prev.convId,
      issueKey: issue || prev.issueKey,
      state: String(state ?? "") || prev.state,
      issueKeys: [...new Set([...prev.issueKeys, ...(issue ? [issue] : [])])],
      sources: [...new Set([...prev.sources, ...(source ? [source] : [])])],
    })
  }

  for (const [key, rec] of Object.entries(book?.issues ?? {})) {
    if (String(rec?.orchestrator ?? "").trim() !== parent) continue
    const worker = workerOf(book, key)
    add({ name: worker.name, convId: worker.convId, issueKey: key, state: rec?.state, source: "dispatch" })
  }
  for (const [name, rec] of Object.entries(book?.sessions ?? {})) {
    if (String(rec?.parent ?? "").trim() !== parent) continue
    const issueKey = String(rec?.issueKey ?? "") || Object.entries(book?.issues ?? {}).find(([, it]) => String(it?.agent ?? "") === name)?.[0] || ""
    add({ name, convId: rec?.convId, issueKey, state: book?.issue?.(issueKey)?.state, source: "dispatch" })
  }
  for (const watch of book?.watch ?? []) {
    const issueKey = String(watch?.issueKey ?? "")
    const owner = String(watch?.parent ?? "").trim() || String(book?.issue?.(issueKey)?.orchestrator ?? "").trim()
    if (owner !== parent) continue
    add({
      name: watch?.name,
      convId: watch?.target,
      issueKey,
      state: book?.issue?.(issueKey)?.state,
      source: "watch",
    })
  }
  return [...rows.values()].sort((a, b) => a.issueKey.localeCompare(b.issueKey) || a.name.localeCompare(b.name) || a.convId.localeCompare(b.convId))
}

// 工作会话建好后绑到编排会话：一处写工单、一处写会话，后续更新认这两个字段。
export function bindWorker(book, { issueKey, name, convId, orchestrator = "", notify = true } = {}) {
  const key = String(issueKey ?? "")
  const number = Number(String(key).split("#")[1] ?? 0) || null
  book.setIssue(key, {
    agent: String(name ?? ""),
    agentConvId: String(convId ?? ""),
    ...(orchestrator ? { orchestrator: String(orchestrator) } : {}),
  })
  book.record(String(name ?? ""), {
    issue: number,
    convId: String(convId ?? ""),
    kind: "worker",
    role: "worker",
    parent: String(orchestrator ?? ""),
    notify: notify !== false,
  })
  return book.session(String(name ?? ""))
}

// 交给编排会话的工单正文：只给决策输入与四个下一步，不把实现塞进编排。
export function ticketText({ repo, issue, orchestrator = "", fresh = false } = {}) {
  const key = `${repo}#${issue?.number}`
  const lines = [`【foreman · 编排会话 · 收到工单】${key} ${String(issue?.title ?? "")}`.trim()]
  lines.push(`工单键：${key}`)
  if (orchestrator) lines.push(`编排会话：${orchestrator}`)
  if (fresh) lines.push("改派原因：检查智能体确认原编排无法继续。请接手工单，先核对现有执行会话与账本，再决定是否续跑或重新 dispatch；不要重复开执行会话。")
  lines.push("", "工单正文：", String(issue?.body ?? "").trim() || "（正文为空，按标题理解）")
  lines.push(
    "",
    "下一步（你只做决策，不写代码）：",
    `1. foreman dispatch --issue ${key} --prompt "<工单分析、这条编码会话的任务范围、依赖与验收要求>" —— 建一工程一工作区、开工作会话，编排指令随首句进入，会话 id 会绑回这条会话；`,
    `2. 工作会话只修改、测试、commit 并给普通最终回复（不输出 RESULT，不 push、不开 PR、不碰工单）；状态与最终回复会经 task.update Inbox 由 Worker queue 进来并带执行会话 id。失败先按编排提示词归因处理，需要原会话续跑时 foreman resume <执行会话id>（不要传工单号）；`,
    `3. 最终回复不是业务结论。你核对提交、diff、测试和工单后，决定是否 push、是否 foreman pr open；Foreman 不会自动 push、自动开 PR 或自动推进工单业务状态；`,
    `4. 核对 PR 后 foreman pr merge <N> --repo <PR 所在仓库>（合并即关单），合完 foreman clean --issue ${key}。`
  )
  return lines.join("\n")
}

// 把一张工单交给它自己的编排：新建时首句同时包含编排职责与完整工单，不再单独 steer。
// 已有绑定说明首句已经发过；调用方会话自己发起了 hand，也已经持有工单上下文。
export async function handToOrchestrator(ctx, { repoCfg, issue, orchestrator = "", fresh = false } = {}) {
  const { cfg, log = () => {} } = ctx
  const gitea = ctx.gitea ?? realGitea
  const key = `${repoCfg.repo}#${Number(issue?.number)}`
  let detail = issue ?? {}
  if (!String(detail.body ?? "").trim()) {
    try {
      const full = await gitea.viewIssue(repoCfg.repo, Number(issue.number))
      detail = { ...full, number: Number(issue.number), title: full?.title ?? issue?.title ?? "", url: full?.url ?? issue?.url ?? "" }
    } catch (e) {
      log(`${key}：读工单正文失败（只按标题交）：${e.message}`)
    }
  }
  const caller = fresh ? "" : String(orchestrator ?? ctx.orchestrator ?? "").trim()
  const convId = caller || (await ensureIssueOrchestrator(ctx, { issueKey: key, repoCfg, issue: detail, withTicket: true, fresh })).convId
  const book = new Book(cfg.stateFile)
  const prev = book.issue(key) ?? {}
  book.setIssue(key, {
    state: "handed",
    repo: repoCfg.repo,
    issue: Number(issue.number),
    title: String(issue.title ?? detail.title ?? ""),
    url: String(issue.url ?? detail.url ?? ""),
    orchestrator: convId,
    ...(fresh && prev.orchestrator && prev.orchestrator !== convId ? { previousOrchestrator: prev.orchestrator } : {}),
    handedAt: nowIso(),
    attempts: Number(prev.attempts ?? 0) || 0,
  })
  log(`${key}：已交给编排会话${convId ? `（${convId}）` : ""}${caller ? "（调用方会话）" : ""}，等它 dispatch`)
  return { repo: repoCfg.repo, number: Number(issue.number), issueKey: key, state: "handed", convId, orchestrator: convId }
}

// 失败续跑：入口只认工作会话 id。先由会话绑定/监听反查工单，再 steer 这条会话本身。
export async function resumeWorker(ctx, { sessionId } = {}) {
  const cfg = ctx?.cfg ?? {}
  const requested = String(sessionId ?? "").trim()
  if (!requested) return { ok: false, reason: "bad-session" }
  const book = new Book(cfg.stateFile)

  let key = ""
  let name = requested
  let target = requested
  for (const [candidate, rec] of Object.entries(book.issues ?? {})) {
    if (String(rec?.agentConvId ?? "") !== requested && String(rec?.agent ?? "") !== requested) continue
    key = candidate
    name = String(rec?.agent ?? "") || requested
    target = String(rec?.agentConvId ?? "") || String(rec?.agent ?? "") || requested
    break
  }
  const watched = book.watch.find((w) => String(w?.target ?? "") === requested || String(w?.name ?? "") === requested)
  if (!key && watched?.issueKey) key = String(watched.issueKey)
  if (watched) {
    name = String(watched.name ?? "") || name
    target = String(watched.target ?? "") || target
  }
  const sessionEntry = Object.entries(book.sessions ?? {}).find(
    ([sessionName, rec]) => sessionName === requested || String(rec?.convId ?? "") === requested,
  )
  if (!key && sessionEntry?.[1]?.issueKey) key = String(sessionEntry[1].issueKey)
  if (sessionEntry) {
    name = sessionEntry[0]
    target = String(sessionEntry[1]?.convId ?? "") || target
  }
  if (!key) return { ok: false, reason: "unknown-session", sessionId: requested }

  const rec = book.issue(key)
  if (!rec) return { ok: false, reason: "unknown-session", sessionId: requested }
  if (!target) return { ok: false, reason: "no-worker" }
  if (typeof ctx.dws?.steer !== "function") return { ok: false, reason: "no-steer" }
  const repo = String(key).split("#")[0]
  const number = Number(String(key).split("#")[1])
  const ws = Array.isArray(rec.workspaces) ? rec.workspaces : []
  const text = resume({
    issue: { number, title: String(rec.title ?? "") },
    attempt: Number(rec.attempts ?? 0) + 1,
    base: String((cfg.repos ?? []).find((r) => r.repo === repo)?.base ?? ""),
    failure: String(rec.lastFailure ?? ""),
    repo,
    workspaces: ws.length ? ws : rec.worktree ? [{ repo, branch: rec.branch ?? "", worktree: rec.worktree }] : [],
  })
  await ctx.dws.steer(target, text)
  book.clearIdle(target)
  book.clearGone(target)
  book.setIssue(key, { state: "working", lastFailure: "", attempts: Number(rec.attempts ?? 0) + 1, resumedAt: nowIso() })
  ctx.log?.(`${key}：已在工作会话 ${target} 里 steer 续跑（不新开）`)
  return { ok: true, issueKey: key, target, convId: target, name, orchestrator: String(rec.orchestrator ?? "") }
}

// 结论后面带决策输入与当前会话 id；具体选补派、续跑还是问人，由编排按原因判断。
export function nextStepLine({ issueKey = "", result = null, sessionId = "" } = {}) {
  const status = String(result?.status ?? "")
  const session = String(sessionId ?? "").trim() || "<执行会话id>"
  if (status === "done") {
    const prs = Array.isArray(result?.prs) && result.prs.length
      ? result.prs
      : Number(result?.pr)
        ? [{ repo: String(issueKey).split("#")[0], pr: Number(result.pr) }]
        : []
    if (!prs.length) return `下一步：核对改动后 foreman pr merge <N> --repo <PR 仓库>；合完 foreman clean --issue ${issueKey}`
    return [
      "下一步：逐条核对后 foreman pr merge <N> --repo <PR 所在仓库>（合并即关单）：",
      ...prs.map((p) => `- ${p.repo}#${p.pr}：foreman pr merge ${p.pr} --repo ${p.repo}`),
      `全合完：foreman clean --issue ${issueKey}`,
    ].join("\n")
  }
  if (status === "need_decision") {
    return `下一步：把上面的问题给用户；答复后用 foreman resume ${session} 在同一工作会话里续跑（别新开）`
  }
  if (status === "none") {
    return [
      "下一步：没有 RESULT 不代表执行失败，先根据上面的最后对话判断实际进展：",
      `- 需要原会话继续：foreman resume ${session}`,
      "- 不要仅因缺少 RESULT 就重跑；已有交付或需要用户拍板时按实际情况处理。",
    ].join("\n")
  }
  if (status === "blocked" || status === "failed") {
    return [
      "下一步：先根据上面的原因选择处理动作，不要固定续跑：",
      `- 原会话能修正：foreman resume ${session}`,
      `- 需要其他智能体协作：新派合适的工作会话并登记监听；它完成后 dws msg --mode steer ${session} "协作结果与继续任务"，让原会话继续；`,
      "- 只有必须由用户拍板时才提问；不要新开重复的同职责会话。",
    ].join("\n")
  }
  return ""
}

// clean：合并关单之后清残留 worktree、本地分支、工作会话、编排会话与监听。
// 幂等：没有产物、已经清过都只回一条 notes；worktree 有未提交改动就保留（不删别人正在写的东西）。
export async function cleanIssue(ctx, { issueKey, archive = true, currentConv = "" } = {}) {
  const cfg = ctx?.cfg ?? {}
  const key = String(issueKey ?? "").trim()
  const book = new Book(cfg.stateFile)
  const rec = book.issue(key)
  if (!rec) return { ok: false, reason: "unknown-issue", notes: [] }
  const keyRepo = String(key).split("#")[0]
  const keyNo = Number(String(key).split("#")[1] ?? 0)
  const notes = []

  // 1) 工作区与本地分支（一工程一工作区）
  const wsList = Array.isArray(rec.workspaces) && rec.workspaces.length
    ? rec.workspaces
    : rec.worktree
      ? [{ repo: rec.repo || keyRepo, branch: rec.branch ?? "", worktree: rec.worktree }]
      : []
  for (const ws of wsList) {
    const repoCfg = (cfg.repos ?? []).find((r) => r.repo === ws.repo) ?? (cfg.repos ?? []).find((r) => r.repo === keyRepo)
    const wt = String(ws.worktree ?? "").trim()
    if (wt) {
      if (!fs.existsSync(wt)) notes.push(`worktree 已不在：${wt}`)
      else {
        let dirty = ""
        try {
          dirty = await statusPorcelain(wt)
        } catch {}
        if (dirty) notes.push(`worktree 有未提交改动，保留：${wt}`)
        else if (repoCfg?.dir && (await worktreeRemove(repoCfg.dir, wt))) notes.push(`worktree 已删除：${wt}`)
        else notes.push(`worktree 删除失败，保留：${wt}`)
      }
    }
    const branch = String(ws.branch ?? "").trim()
    if (branch && repoCfg?.dir) {
      try {
        await git(["branch", "-d", branch], { cwd: repoCfg.dir })
        notes.push(`本地分支 ${branch} 已删`)
      } catch {
        notes.push(`本地分支 ${branch} 未删（未合并入基线，或已经不存在）`)
      }
    }
  }

  // 2) 工作会话与监听：按账本绑定的会话 + 监听里同一条单的登记一起收。
  // 同一条会话可能既有名字又有 convId：按 convId 去重，避免归档两次。
  const targets = new Map() // target(convId 或名字) -> { target, name }
  const addTarget = (name, convId) => {
    const nm = String(name ?? "").trim()
    const cv = String(convId ?? "").trim()
    const target = cv || nm
    if (!target) return
    const prev = targets.get(target)
    targets.set(target, { target, name: prev?.name || nm || target })
  }
  const w = workerOf(book, key)
  addTarget(w.name, w.convId)
  for (const r of cfg.repos ?? []) {
    if (r.repo !== keyRepo) continue
    const legacy = `foreman-${r.name}-${keyNo}`
    if (book.session(legacy) || book.watch.some((x) => String(x.name ?? "") === legacy)) {
      addTarget(legacy, book.session(legacy)?.convId)
    }
  }
  for (const entry of [...book.watch]) {
    if (String(entry.issueKey ?? "") !== key) continue
    const nm = String(entry.name ?? entry.target ?? "")
    addTarget(nm, book.session(nm)?.convId || (String(entry.target).startsWith("conv") ? entry.target : ""))
    book.delWatch(entry.target)
  }
  for (const { target, name } of targets.values()) {
    if (archive && typeof ctx.dws?.archive === "function") {
      try {
        await ctx.dws.archive(target)
        notes.push(`工作会话已归档：${name || target}`)
        ctx.log?.(`clean：工作会话已归档 ${target}`)
      } catch (e) {
        notes.push(`工作会话 ${name || target} 归档失败：${String(e?.message ?? e).slice(0, 120)}`)
      }
    }
    if (name && name !== target) book.delSession(name)
    book.delSession(target)
    book.delWatch(target)
  }

  // 2.5) 这张单自己的编排会话：收口后它没有下一件事了，一并归档。
  // 早先只收工作会话与监听，编排会话留在侧边栏里越积越多（每张单一条）。
  // 只认账本里 foreman 为这张单建的那条：调用方自己发起的会话（用户会话）与全局编排一律不碰；
  // 正在发出这条命令的会话也不归档（dws 本来也拒绝归档命令发起方），留给服务下一轮收。
  const own = ownedIssueOrchestrator(book, key)
  if (own) {
    const target = own.convId || own.name
    const caller = String(currentConv ?? "").trim()
    if (caller && (caller === own.convId || caller === own.name)) {
      notes.push(`编排会话 ${own.name || target} 就是当前会话，留给服务在收口后归档`)
    } else if (archive && typeof ctx.dws?.archive === "function") {
      try {
        await ctx.dws.archive(target)
        notes.push(`编排会话已归档：${own.name || target}`)
        ctx.log?.(`clean：编排会话已归档 ${target}`)
        book.delSession(own.name)
        book.setIssue(key, { orchestrator: "" })
      } catch (e) {
        notes.push(`编排会话 ${own.name || target} 归档失败：${String(e?.message ?? e).slice(0, 120)}`)
      }
    }
  }

  // 3) 账本收尾：会话字段清空，已合并的单落到 done
  const state = ["done", "pr-open", "cleaned"].includes(String(rec.state ?? "")) ? "done" : String(rec.state ?? "")
  book.setIssue(key, { agent: "", agentConvId: "", cleanedAt: nowIso(), ...(state ? { state } : {}) })
  try {
    ctx.consoleStore?.sync(new Book(cfg.stateFile))
  } catch {}
  return { ok: true, issueKey: key, notes, cleanedAt: nowIso() }
}

// --all 时清哪些：终端态（已合并/已关单）且有工作区痕迹的单，
// 或者只剩自己那条编排会话没收的单（否则老的残留会话永远扫不到）。
export function cleanableIssues(book) {
  return Object.entries(book?.issues ?? {})
    .filter(([, it]) => TERMINAL_ISSUE_STATES.includes(String(it?.state ?? "")))
    .filter(
      ([key, it]) =>
        !!it?.worktree ||
        (Array.isArray(it?.workspaces) && it.workspaces.length) ||
        !!String(it?.agent ?? "").trim() ||
        !!ownedIssueOrchestrator(book, key),
    )
    .map(([key]) => key)
}
