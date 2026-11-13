// 以编排会话为中心：整条链路只有一条编排智能体会话，工作会话都绑在它身上。
//
// 与老模型的区别（老：每次收工新建「派单/合并」会话、由服务通知）：
//   - 编排会话只起一次（ensureOrchestrator 幂等），后面全靠 dws steer 往里插消息；
//   - 工单先交给编排（hand），由编排调 `foreman dispatch` 分配工作；
//   - 工作会话 id 写进账本 issues[<键>] 的 agent / agentConvId / orchestrator；
//   - 工作会话失败用 `foreman resume` 在**同一条**工作会话里 steer 续跑，绝不新开；
//   - 合并关单之后 `foreman clean` 清 worktree 与会话。
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

// 编排会话 id：账本顶层 orchestrator.convId；没有就是空串（调用方决定降级还是先 ensure）。
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

export function orchestratorPrompt(ctx = {}) {
  const cfg = ctx.cfg ?? {}
  const projectDir = String(cfg.sessionFlow?.projectDir ?? cfg.deliver?.projectDir ?? "").trim()
  const maxRunning = Number(cfg.pickup?.maxRunning) || 2
  const base = String((cfg.repos ?? [])[0]?.base ?? "").trim()
  const lines = [orchestratorBasePrompt(cfg).trim(), "", "---", ""]
  if (projectDir) lines.push(`监控项目：${projectDir}`)
  lines.push(`通道：派单（同时在跑最多 ${maxRunning} 条工作会话）`)
  if (base) lines.push(`基线：origin/${base}`)
  lines.push("工单会 steer 进这条会话（正文带「工单键」）；实现只在工作会话里，你不写代码。")
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

// 一张单的编排会话：先看绑在单上的（用户自主发起时会话 id 就记在这里），
// 没有才回落到 foreman 起的那条全局编排会话。
export function orchestratorOf(book, issueKey = "", fallback = "") {
  const own = String(book?.issue?.(String(issueKey ?? ""))?.orchestrator ?? "").trim()
  return own || String(fallback ?? "").trim() || orchestratorTarget(book)
}

// 往编排会话里插一条（dws steer：Command+Enter，不打断它当前那一轮）。
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
export function ticketText({ repo, issue, orchestrator = "" } = {}) {
  const key = `${repo}#${issue?.number}`
  const lines = [`【foreman · 编排会话 · 收到工单】${key} ${String(issue?.title ?? "")}`.trim()]
  lines.push(`工单键：${key}`)
  if (orchestrator) lines.push(`编排会话：${orchestrator}`)
  lines.push("", "工单正文：", String(issue?.body ?? "").trim() || "（正文为空，按标题理解）")
  lines.push(
    "",
    "下一步（你只做决策，不写代码）：",
    `1. foreman dispatch --issue ${key} —— 建一工程一工作区、开工作会话，会话 id 会绑回这条会话；`,
    `2. 工作会话的更新会 steer 进来；失败就 foreman resume --issue ${key}（同一会话里续跑，别新开）；`,
    `3. done 带 PR 就核对后 foreman pr merge <N> --repo <PR 所在仓库>（合并即关单）；`,
    `4. 合完 foreman clean --issue ${key}，清 worktree 与工作会话。`
  )
  return lines.join("\n")
}

// 把一张工单交给编排：起/复用编排会话 → steer 工单 → 账本记 handed（等编排来 dispatch）。
// orchestrator 给了就直接交给那条会话（用户自主发起：它自己就是编排），不再去起全局编排会话。
export async function handToOrchestrator(ctx, { repoCfg, issue, orchestrator = "" } = {}) {
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
  const caller = String(orchestrator ?? ctx.orchestrator ?? "").trim()
  const convId = caller || (await ensureOrchestrator(ctx)).convId
  await steerOrchestrator(ctx, ticketText({ repo: repoCfg.repo, issue: detail, orchestrator: convId }), {
    kind: "ticket",
    target: convId,
  })
  const book = new Book(cfg.stateFile)
  const prev = book.issue(key) ?? {}
  book.setIssue(key, {
    state: "handed",
    repo: repoCfg.repo,
    issue: Number(issue.number),
    title: String(issue.title ?? detail.title ?? ""),
    url: String(issue.url ?? detail.url ?? ""),
    orchestrator: convId,
    handedAt: nowIso(),
    attempts: Number(prev.attempts ?? 0) || 0,
  })
  log(`${key}：已交给编排会话${convId ? `（${convId}）` : ""}${caller ? "（调用方会话）" : ""}，等它 dispatch`)
  return { repo: repoCfg.repo, number: Number(issue.number), issueKey: key, state: "handed", convId, orchestrator: convId }
}

// 失败续跑：在同一条工作会话里 steer，不新开（编排侧只看这一条）。
export async function resumeWorker(ctx, { issueKey } = {}) {
  const cfg = ctx?.cfg ?? {}
  const key = String(issueKey ?? "").trim()
  const m = key.match(/^([^#\s]+)#([0-9]+)$/)
  if (!m) return { ok: false, reason: "bad-issue" }
  const repo = m[1]
  const number = Number(m[2])
  const book = new Book(cfg.stateFile)
  const rec = book.issue(key)
  if (!rec) return { ok: false, reason: "unknown-issue" }
  const w = workerOf(book, key)
  const target = w.convId || w.name
  if (!target) return { ok: false, reason: "no-worker" }
  if (typeof ctx.dws?.steer !== "function") return { ok: false, reason: "no-steer" }
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
  book.setIssue(key, { state: "working", lastFailure: "", attempts: Number(rec.attempts ?? 0) + 1, resumedAt: nowIso() })
  ctx.log?.(`${key}：已在工作会话 ${target} 里 steer 续跑（不新开）`)
  return { ok: true, issueKey: key, target, convId: w.convId, name: w.name, orchestrator: w.orchestrator }
}

// 结论后面跟的「下一步」：编排会话读到就知道该 dispatch / resume / merge / clean 哪一个。
export function nextStepLine({ issueKey = "", result = null } = {}) {
  const status = String(result?.status ?? "")
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
    return `下一步：把上面的问题给用户；答复后用 foreman resume --issue ${issueKey} 在同一工作会话里续跑（别新开）`
  }
  if (status === "blocked" || status === "failed") {
    return `下一步：foreman resume --issue ${issueKey} —— 用 steer 在这条工作会话里续跑，不要新开工作会话`
  }
  return ""
}

// clean：合并关单之后清残留 worktree、本地分支、工作会话与监听。
// 幂等：没有产物、已经清过都只回一条 notes；worktree 有未提交改动就保留（不删别人正在写的东西）。
export async function cleanIssue(ctx, { issueKey, archive = true } = {}) {
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

  // 3) 账本收尾：会话字段清空，已合并的单落到 done
  const state = ["done", "pr-open", "cleaned"].includes(String(rec.state ?? "")) ? "done" : String(rec.state ?? "")
  book.setIssue(key, { agent: "", agentConvId: "", cleanedAt: nowIso(), ...(state ? { state } : {}) })
  try {
    ctx.consoleStore?.sync(new Book(cfg.stateFile))
  } catch {}
  return { ok: true, issueKey: key, notes, cleanedAt: nowIso() }
}

// --all 时清哪些：终端态（已合并/已关单）且有工作区痕迹的单。
export function cleanableIssues(book) {
  return Object.entries(book?.issues ?? {})
    .filter(([, it]) => ["done", "cleaned"].includes(String(it?.state ?? "")))
    .filter(
      ([, it]) =>
        !!it?.worktree ||
        (Array.isArray(it?.workspaces) && it.workspaces.length) ||
        !!String(it?.agent ?? "").trim(),
    )
    .map(([key]) => key)
}
