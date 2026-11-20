// 编排：捞单 → herdr 建工作区 → dws 开会话派活 → 记账 → 登记监听 → 返回。
// run 现在只派活：不等会话回复、不读 RESULT、不验收、不 push/PR、不发通知。
// 通知由常驻服务按 pollSeconds 轮询 dws status 后异步发出（见 service.mjs）。
// 三个工具各管一段：gitea 管工单，herdr 管 worktree，dws 管豆包会话。
import fs from "node:fs"
import path from "node:path"
import { exec, nowIso } from "./util.mjs"
import * as realGitea from "./gitea.mjs"
import {
  commitsAhead,
  createWorktree,
  diffStat,
  pushBranch,
  recentCommits,
  statusPorcelain,
  worktreeRemove,
} from "./gitx.mjs"
import { decisionKickoff, doneComment, holdComment, issueBranch, kickoff, originalAgentDocs, prBody, resume, withAgentDocs } from "./prompts.mjs"
import { findWorkspace, reposForIssue, workspacePath } from "./workspaces.mjs"
import { Book } from "./book.mjs"
import { startOperation, finishOperation } from "./operations.mjs"
import { bindWorker, ensureIssueOrchestrator, handToOrchestrator, sessionFlowEnabled, workerOf } from "./sessionflow.mjs"

export const issueKey = (repo, n) => `${repo}#${n}`

// 收口要通知哪些状态；和 state.json 里的状态名一致（服务侧复用）。
export const NOTIFY_EVENTS = ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"]

// 通知目标：显式配了 session 就用它（id 或侧边栏标题都行）；写 auto 时取调用方会话 id。
export function notifyTarget(notify = {}, env = process.env) {
  if (!notify || notify.enabled === false) return ""
  const s = String(notify.session ?? "auto").trim()
  if (s && s !== "auto") return s
  return String(env.MCP_VM_CONVERSATION_ID ?? "").trim()
}

// 这一条结果值不值得通知。
export function shouldNotify(notify = {}, state = "") {
  if (!notify || notify.enabled === false) return false
  const events = Array.isArray(notify.events) ? notify.events : NOTIFY_EVENTS
  return events.includes(String(state ?? ""))
}

// 通知正文：一眼能看出哪条单、什么结果、有没有 PR、是哪条会话跑出来的。
// 执行会话 id 必须带：编排会话要靠它 dws info 排查 / 续跑，光给工单号无从下手。
export function notifyText(issue = {}, out = {}) {
  const title = String(issue.title ?? "").trim()
  const head = `${issue.repo ? `${issue.repo} ` : ""}#${issue.number}${title ? ` ${title}` : ""}`
  const lines = [`【foreman】${head}`, `状态：${out.state ?? "unknown"}`]
  if (out.session) lines.push(`执行会话：${out.session}${out.sessionName && out.sessionName !== out.session ? `（${out.sessionName}）` : ""}`)
  if (out.branch) lines.push(`分支：${out.branch}`)
  // 一工程一工作区：跨工程时先把这份清单摆出来，编排侧一眼看清这条单动了几处。
  const workspaces = Array.isArray(out.workspaces) ? out.workspaces : []
  if (workspaces.length > 1) {
    lines.push(`工作区（${workspaces.length} 个工程）：`)
    for (const w of workspaces) lines.push(`- ${w.repo} → ${w.branch ?? ""}${w.worktree ? `（${w.worktree}）` : ""}`)
  }
  if (out.pr) lines.push(`PR：#${out.pr}${out.prUrl ? ` ${out.prUrl}` : ""}`)
  if (out.merged) lines.push(`合并：已合并 PR #${out.pr}`)
  else if (out.mergeError) lines.push(`合并失败：${String(out.mergeError).slice(0, 200)}`)
  else if (out.pr) lines.push(`合并：PR 已开好，核对工单/改动后自己跑 foreman pr merge ${out.pr}（不再有合并通道）`)
  if (out.cleanup?.notes?.length) lines.push(`清理：${out.cleanup.notes.join("；")}`)
  if (out.reason) lines.push(`原因：${String(out.reason).slice(0, 200)}`)
  // 合并也交一个 RESULT 块：编排会话读完就能收尾、这条通知会话随后可归档（dws archive）。
  if (out.merged && out.pr) {
    const summary = [`PR #${out.pr} 已合并`, ...(out.cleanup?.notes ?? [])].join("；")
    lines.push("", `<RESULT>${JSON.stringify({
      status: "done",
      pr: out.pr,
      prUrl: out.prUrl || "",
      merged: true,
      cleanup: out.cleanup?.notes ?? [],
      summary: summary.slice(0, 400),
    })}</RESULT>`)
  }
  // 没有 RESULT 不等于失败：贴最近多轮对话，编排侧才能判断实际进展；旧适配器仍用最后一句兜底。
  if (out.conversation) {
    lines.push("", "没有检测到 RESULT，执行会话的最后对话原文：", String(out.conversation))
  } else if (out.lastReply) {
    lines.push("", "没有检测到 RESULT，执行会话的最后一条回复原文：", String(out.lastReply).slice(-1500))
  }
  return lines.join("\n")
}

// 这些状态说明这条单已经被处理过一遍，不再自动捞。
export const CLOSED_STATES = new Set(["done", "needs-human", "blocked", "escalated", "pr-open"])

export function eligible(issues, repoCfg, cfg, book) {
  const exclude = new Set((cfg.pickup.excludeLabels ?? []).map((s) => String(s).toLowerCase()))
  const require = cfg.pickup.labelIds?.length ? [] : (cfg.pickup.labels ?? []).map((s) => String(s).toLowerCase())
  const extra = (repoCfg.labels ?? []).map((s) => String(s).toLowerCase())
  return (issues ?? []).filter((it) => {
    if (!it?.number) return false
    const labels = (it.labels ?? []).map((l) => String(l).toLowerCase())
    if (labels.some((l) => exclude.has(l))) return false
    if (require.length && !require.every((l) => labels.includes(l))) return false
    if (extra.length && !extra.every((l) => labels.includes(l))) return false
    if (cfg.pickup.onlyUnassigned && (it.assignees ?? []).length) return false
    const rec = book.issue(issueKey(repoCfg.repo, it.number))
    if (rec && CLOSED_STATES.has(rec.state)) return false
    // 已经交给编排会话、等它 dispatch 的单不再捞：再交一次会让编排重复派活。
    if (rec && rec.state === "handed") return false
    // 在飞（working 且不是派单失败）不再捞：续跑是编排 AI / 人工 foreman retry 的决定。
    // 否则每轮巡检都会给同一张单再发一次「继续处理」（#268 被连派两次就是这么来的）。
    if (rec && rec.state === "working" && !rec.lastFailure) return false
    if (rec && rec.state === "working" && (rec.attempts ?? 0) >= cfg.maxAttempts) return false
    return true
  })
}

// 三档：mine（作者是我）、unassigned（无人认领）、others（别人认领）。不同档先按 priority 排，同档按时间。
export function bucketOf(issue = {}, me = "") {
  if (me && String(issue.author ?? "") === String(me)) return "mine"
  if (!(issue.assignees ?? []).length) return "unassigned"
  return "others"
}

export function sortIssues(issues, order = "oldest", { me = "", priority = ["mine", "unassigned", "others"] } = {}) {
  const t = (x) => new Date(x.createdAt || 0).getTime()
  const rank = (x) => {
    const i = priority.indexOf(bucketOf(x, me))
    return i < 0 ? priority.length : i
  }
  return [...issues].sort((a, b) => rank(a) - rank(b) || (order === "newest" ? t(b) - t(a) : t(a) - t(b)))
}

// 一轮：每个仓库各自捞、各自做，做完一条接一条。只派活，不等结果。
// 会话中心模式（默认，sessionFlow.enabled）下每张工单交给各自新建的编排会话，
// 由它调 foreman dispatch 分配工作；ctx.hand=false 或 pickup.handToOrchestrator=false 才自己派。
export async function runRound(ctx) {
  const { cfg, book, log } = ctx
  const gitea = ctx.gitea ?? realGitea
  const hand = ctx.hand ?? (sessionFlowEnabled(cfg) && cfg.pickup?.handToOrchestrator === true)
  const handled = []
  for (const repoCfg of cfg.repos) {
    if (ctx.only && ![repoCfg.name, repoCfg.repo].includes(ctx.only)) continue
    if (ctx.dryRun) log(`[dry-run] 看 ${repoCfg.repo} 的待接工单（不会建工作区、不会动会话）`)

    const labelQuery = (repoCfg.labelIds ?? cfg.pickup.labelIds ?? []).join(",")
    let list = []
    try {
      list = await gitea.listIssues(repoCfg.repo, { label: labelQuery })
    } catch (e) {
      log(`拉 ${repoCfg.repo} 的工单失败，跳过这个仓库：${e.message}`)
      continue
    }
    const pool = sortIssues(eligible(list, repoCfg, cfg, book), cfg.pickup.order, { me: cfg.pickup.me, priority: cfg.pickup.priority })
    log(`${repoCfg.repo}：open ${list.length} 条，可接 ${pool.length} 条`)

    let count = 0
    for (const it of pool) {
      if (count >= cfg.perRepoPerRound) break
      // 服务端自动巡检时限制整轮总数（豆包单实例，一轮只派一条），CLI 不传就没有这个上限。
      if (ctx.maxTotal && handled.length >= ctx.maxTotal) break
      count++
      let out
      const key = issueKey(repoCfg.repo, it.number)
      const op = ctx.dryRun ? 0 : startOperation(ctx, "dispatch", `${hand ? "交给编排" : "派单"} ${key}`, {
        key,
        detail: hand ? "把工单交给编排会话，由它调 foreman dispatch" : it.title || "读工单、准备工作区并启动执行会话",
      })
      try {
        if (hand && ctx.dryRun) {
          // dry-run 不许有副作用：只打印这张单会绑定哪条独立编排，不 ensure、不 steer。
          const target = String(book?.issue?.(key)?.orchestrator ?? "").trim()
          log(`[dry-run] ${key}：会交给这张单的独立编排会话 ${target || "（还没起，首句会带上编排职责与工单）"}，由它调 foreman dispatch`)
          out = { repo: repoCfg.repo, number: it.number, state: "planned", hand: true, orchestrator: target }
        } else {
          out = hand
            ? await handToOrchestrator({ ...ctx, gitea }, { repoCfg, issue: it })
            : await handleIssue(ctx, repoCfg, it)
        }
        const success = out.state === "dispatched" || out.state === "planned" || out.state === "handed"
        finishOperation(
          ctx,
          op,
          success ? "success" : "failed",
          out.state === "handed"
            ? `已交给编排会话${out.convId ? ` · ${out.convId}` : ""}`
            : out.convId
              ? `已派出到执行会话 · 分支 ${out.branch || "-"}`
              : out.reason || out.state
        )
      } catch (e) {
        finishOperation(ctx, op, "failed", e.message)
        if (e.code === "app_unavailable") throw e
        log(`${repoCfg.repo} #${it.number} 派活失败：${e.message}`)
        out = { repo: repoCfg.repo, number: it.number, state: "failed", reason: e.message }
      }
      handled.push(out)
    }
    if (ctx.once) break
  }
  return handled
}

// 编排的分析与任务拆分必须随派单首句一起进编码会话，不能派完后才补 steer。
// 续跑同一条会话时也拼进同一条消息；标准提示词里的工作区与交付边界仍然优先。
function withDispatchPrompt(text, extra = "") {
  const instruction = String(extra ?? "").trim()
  if (!instruction) return text
  return `${String(text ?? "").trim()}\n\n---\n\n编排智能体补充指令（本次派单，仍需遵守上述工作区与交付边界）：\n${instruction}`
}

// 派活：读工单 → 建/复用 worktree → 记账 working → dws.open/send 派出去 → 记账会话 → 登记监听。
// 返回 { repo, number, state:"dispatched", branch, convId }。不 waitFinished、不 info、不验收、不 PR。
export async function handleIssue(ctx, repoCfg, summary) {
  const { cfg, dws, log } = ctx
  const dispatchPrompt = String(ctx.dispatchPrompt ?? "").trim()
  // 账本兜底：自动接单那一路（pickup/run）的 ctx 自带 book，服务里 `foreman dispatch` 那条 RPC
  // 用的是服务级 ctx（只有 state/cfg/dws/engine），不带 book——不兜底就会在 book.issue 上崩
  // （Cannot read properties of undefined (reading 'issue')）。
  const book = ctx.book ?? new Book(cfg.stateFile)
  const gitea = ctx.gitea ?? realGitea
  const key = issueKey(repoCfg.repo, summary.number)
  const prev = book.issue(key) ?? {}
  const name = `foreman-${repoCfg.name}-${summary.number}`

  const issue = await gitea.viewIssue(repoCfg.repo, summary.number)
  issue.number = summary.number
  issue.title ||= summary.title
  issue.url ||= summary.url

  const branch = prev.branch || issueBranch(issue, issue.title)

  // 默认只建主仓工作区；额外工程由编排通过 dispatch --repo 显式指定。
  // 正文里的工程名只作上下文，不再自动等同于改动范围；漏建由编排用 `foreman ws add` 补开。
  const targets = reposForIssue(issue, cfg.repos, repoCfg, { extraRepos: ctx.extraRepos ?? [] })
  const agentDocs = originalAgentDocs(targets)

  // dry-run：只打印会建在哪、会发什么，零副作用。
  if (ctx.dryRun) {
    const plan = targets.map((r) => {
      const ws = findWorkspace(prev, r.repo)
      const b = ws?.branch || issueBranch(issue, issue.title)
      return { repo: r.repo, name: r.name, branch: b, base: r.base, worktree: workspacePath(cfg.worktreeDir, r, b) }
    })
    const basePrompt = ctx.decision
      ? decisionKickoff({ repo: repoCfg.repo, issue, base: repoCfg.base, workspaces: plan, labels: issue.labels ?? [], attempt: (prev.attempts ?? 0) + 1 })
      : kickoff({
          repo: repoCfg.repo,
          issue,
          base: repoCfg.base,
          workspaces: plan,
          attempt: (prev.attempts ?? 0) + 1,
          lastFailure: prev.lastFailure ?? "",
        })
    const prompt = withDispatchPrompt(withAgentDocs(basePrompt, agentDocs), dispatchPrompt)
    log(
      `[dry-run] ${key}\n  工程 ${plan.length} 个：${plan.map((w) => `${w.repo} → ${w.worktree}（${w.branch}）`).join("；")}\n  会话：${name}\n  首句：\n${prompt}`
    )
    return { repo: repoCfg.repo, number: issue.number, state: "planned", branch: plan[0]?.branch ?? branch, worktree: plan[0]?.worktree ?? "", workspaces: plan, prompt }
  }

  // 逐个工程建工作区。主仓库失败就挂起整单；附加工程失败只记一条，写进首句让会话按需补开。
  const workspaces = []
  const failedWorkspaces = []
  for (const r of targets) {
    const ws = findWorkspace(prev, r.repo)
    const b = ws?.branch || issueBranch(issue, issue.title)
    try {
      const wt = await createWorktree({
        repoDir: r.dir,
        worktreeDir: path.join(cfg.worktreeDir, r.name),
        branch: b,
        base: r.base,
        herdrBin: cfg.herdr?.bin ?? "herdr",
        useHerdr: cfg.herdr?.enabled !== false,
        log,
      })
      workspaces.push({ repo: r.repo, name: r.name, branch: b, base: r.base, worktree: wt.path, backend: wt.backend, reused: !!wt.reused })
      log(`${key}：工作区 ${wt.path}（${r.repo}·${wt.reused ? "复用" : `新建·${wt.backend}`}）`)
    } catch (e) {
      if (r.repo === repoCfg.repo) {
        await hold(ctx, repoCfg, issue, {
          status: "blocked",
          summary: `工作区准备失败：${e.message}`,
          question: "",
        }, workspacePath(cfg.worktreeDir, r, b), key)
        return { repo: repoCfg.repo, number: issue.number, state: "blocked", reason: "workspace" }
      }
      failedWorkspaces.push({ repo: r.repo, error: String(e?.message ?? e).slice(0, 200) })
      log(`${key}：附加工程 ${r.repo} 的工作区没建成（${String(e?.message ?? e).slice(0, 200)}），留给会话按需 foreman ws add`)
    }
  }

  // 分支建好后指定原工单右侧的分支 / Git 标签（Gitea Issue.ref），不发评论。
  // 多工程工单只有一个 ref 字段，统一写主仓分支；值不变时不重复 PATCH。
  const primary = workspaces[0]
  let branchRef = prev.branchRef ?? null
  if (primary && issue.ref !== primary.branch && typeof gitea.editIssue === "function") {
    try {
      await gitea.editIssue(repoCfg.repo, issue.number, { ref: primary.branch })
      branchRef = { branch: primary.branch, at: nowIso() }
      log(`${key}：已指定工单右侧分支 ${primary.branch}`)
    } catch (e) {
      log(`${key}：工单右侧分支更新失败，继续派单，下次重派可补写：${String(e?.message ?? e).slice(0, 200)}`)
    }
  }

  const attempt = (prev.attempts ?? 0) + 1
  // 决策单（needs-info 这类标签的手动接单）：提示词换成「先判断再决定动不动手」，不绑编排会话。
  // 注意会话仍走 openNew（只确认送达）：dws.open 会等第一轮跑完，会把 HTTP 请求拖到超时。
  const decision = ctx.decision === true
  const flowOn = sessionFlowEnabled(cfg)
  const orchOn = flowOn && !decision
  // 编排会话有两种来源，都写进 issues[键].orchestrator，后续更新一律 steer 到它：
  //   1) 定时任务自动接单：这张单自己新建一条编排会话（ensureIssueOrchestrator 按单幂等）；
  //   2) 用户自主发起的会话调 dispatch：直接把调用方会话 id 绑成这张单的编排（--orchestrator / MCP_VM_CONVERSATION_ID）。
  const caller = String(ctx.orchestrator ?? "").trim()
  let orchConvId = orchOn ? caller || String(prev.orchestrator ?? "").trim() : ""
  if (orchOn && !orchConvId) {
    // 没有安全绑定就不开工作会话，避免工作成果出来后无处可 steer。
    try {
      orchConvId = (await ensureIssueOrchestrator(ctx, { issueKey: key, repoCfg, issue })).convId
    } catch (e) {
      log(`${key}：独立编排会话没起来，暂停派单：${e.message}`)
      return { repo: repoCfg.repo, number: issue.number, state: "failed", reason: `编排会话没起来：${e.message}` }
    }
  } else if (orchOn && caller) {
    log(`${key}：绑定调用方会话 ${caller} 为这张单的编排（用户自主发起）`)
  }

  book.setIssue(key, {
    state: "working",
    issue: issue.number,
    title: issue.title,
    url: issue.url,
    repo: repoCfg.repo,
    branch: primary?.branch ?? branch,
    worktree: primary?.worktree ?? "",
    workspaces,
    attempts: attempt,
    lastFailure: "",
    ...(branchRef ? { branchRef } : {}),
    ...(decision ? { decision: true } : {}),
    ...(orchConvId ? { orchestrator: orchConvId } : {}),
  })

  // 派活：这条单已经有工作会话就 **steer 续跑同一条**（失败重试也不新开第二条），
  // 没有才开新的。会话中心模式下用 openNew（只确认送达），更新经 task.update Inbox 由 Worker queue 回编排。
  const bound = workerOf(book, key)
  const agentName = bound.name || name
  const boundTarget = bound.convId || bound.name || book.session(name)?.convId || ""
  let convId = bound.convId || book.session(name)?.convId || ""
  const resumeText = withDispatchPrompt(
    withAgentDocs(resume({ issue, attempt, base: repoCfg.base, failure: prev.lastFailure ?? "", repo: repoCfg.repo, workspaces }), agentDocs),
    dispatchPrompt,
  )
  // 决策单首句：走另一套提示词，让 agent 自己判断要不要做、缺什么信息。
  const baseKickoff = decision
    ? decisionKickoff({ repo: repoCfg.repo, issue, base: repoCfg.base, workspaces, labels: issue.labels ?? [], attempt })
    : kickoff({
        repo: repoCfg.repo,
        issue,
        base: repoCfg.base,
        workspaces,
        failedWorkspaces,
        attempt,
        lastFailure: prev.lastFailure ?? "",
      })
  const kickoffText = withDispatchPrompt(withAgentDocs(baseKickoff, agentDocs), dispatchPrompt)
  try {
    if (boundTarget) {
      // 决策单续跑也发决策提示词：上一次的「继续改」口径会把 agent 又推回去直接写代码。
      const again = decision ? kickoffText : resumeText
      if (flowOn && typeof dws.steer === "function") {
        log(`${key}：steer 已有工作会话 ${boundTarget}（attempt ${attempt}，不新开）`)
        await dws.steer(boundTarget, again)
      } else {
        log(`${key}：续会话 ${agentName}（attempt ${attempt}）`)
        await dws.send(agentName, again)
      }
      book.clearIdle(boundTarget)
      book.clearGone(boundTarget)
    } else if (flowOn && typeof dws.openNew === "function") {
      log(`${key}：开工作会话 ${agentName}（attempt ${attempt}，只确认送达）`)
      const opened = await dws.openNew({
        name: agentName,
        prompt: kickoffText,
        noWait: true,
      })
      convId = String(opened?.convId ?? "").trim()
    } else {
      log(`${key}：开新会话 ${name}（attempt ${attempt}）`)
      const opened = await dws.open({
        name,
        repo: repoCfg.repo,
        prompt: kickoffText,
      })
      convId = opened.convId ?? ""
    }
  } catch (e) {
    if (e.code === "app_unavailable") {
      book.setIssue(key, { state: "blocked", lastFailure: e.message })
      throw e
    }
    book.setIssue(key, { lastFailure: `会话没跑通：${e.message}` })
    log(`${key}：派活失败 —— ${e.message}`)
    return { repo: repoCfg.repo, number: issue.number, state: "failed", reason: e.message }
  }

  // --no-notify：不登记监听，同时账本标 notify:false，免得被 sessions 自动纳入规则捞回来。
  // 决策单一律不监听：它要的是 agent 的判断与提问，不是「跑完了吗 / 出 PR 了吗」。
  const noNotify = !!ctx.noNotify || decision
  // 工作会话 id 绑到编排会话：后续 task.update 事件按这条绑定由 Worker queue 回编排。
  bindWorker(book, {
    issueKey: key,
    name: agentName,
    convId,
    orchestrator: orchConvId,
    notify: !noNotify,
  })

  if (!noNotify && convId) {
    book.setWatch({
      target: convId,
      name: agentName,
      issueKey: key,
      repo: repoCfg.repo,
      number: issue.number,
      notifyTo: ctx.notifyTo ?? "",
    })
  }

  log(`${key}：已${boundTarget ? "steer" : "派活"} → ${convId || agentName}${noNotify ? "（不登记监听）" : ""}${orchConvId ? `，绑定编排会话 ${orchConvId}` : ""}`)
  return {
    repo: repoCfg.repo,
    number: issue.number,
    state: "dispatched",
    branch: primary?.branch ?? branch,
    worktree: primary?.worktree ?? "",
    workspaces: workspaces.map((w) => ({ repo: w.repo, branch: w.branch, worktree: w.worktree })),
    convId,
    agent: agentName,
    orchestrator: orchConvId,
    resumed: !!boundTarget,
  }
}

// 验收三条：工作区干净、分支有提交、配置里的 verify 命令全过。（保留能力，run 不再自动调用）
export async function verify(ctx, wt, repoCfg) {
  const dirty = await statusPorcelain(wt)
  if (dirty) return { ok: false, why: `工作区还有未提交/未清理的改动：${dirty.split("\n").slice(0, 5).join(" / ")}` }
  const ahead = await commitsAhead(wt, repoCfg.base)
  if (!ahead) return { ok: false, why: `分支上没有新提交（origin/${repoCfg.base}..HEAD = 0）` }
  for (const cmd of repoCfg.verify ?? []) {
    try {
      await exec("bash", ["-lc", cmd], { cwd: wt, timeout: 1800000 })
    } catch (e) {
      return {
        ok: false,
        why: `验收命令失败：${cmd}\n${String(e.stderr || e.stdout || e.message).slice(-800)}`,
      }
    }
  }
  return { ok: true, ahead }
}

// push/PR/合并/关单。（保留能力，run 不再自动调用）
async function publish(ctx, repoCfg, issue, wt, result, check, key) {
  const { cfg, log } = ctx
  const commits = await recentCommits(wt.path, repoCfg.base)
  const stat = await diffStat(wt.path, repoCfg.base)

  await pushBranch(wt.path, wt.branch)
  log(`${key}：已 push ${wt.branch}`)

  const pr = await realGitea.createPr({
    repo: repoCfg.repo,
    base: repoCfg.base,
    head: wt.branch,
    title: `fix(#${issue.number}): ${issue.title}`,
    body: prBody({ issue, summary: result.summary, tests: result.tests, commits, stat, base: repoCfg.base }),
  })
  log(`${key}：PR ${pr.number ? `#${pr.number}` : "已创建（没拿到编号）"}`)

  let state = "pr-open"
  if (cfg.merge?.enabled) {
    await realGitea.mergePr(repoCfg.repo, pr.number, {
      style: cfg.merge.style ?? "merge",
      deleteBranch: cfg.merge.deleteBranch !== false,
    })
    await realGitea.closeIssue(repoCfg.repo, issue.number)
    state = "done"
  }

  await realGitea
    .commentIssue(repoCfg.repo, issue.number, doneComment({ pr, tests: result.tests, summary: result.summary }))
    .catch((e) => log(`${key}：回帖工单失败（不影响主流程）：${e.message}`))
  // 约定：PR 开出即交回人工——摘 ready-for-agent、打 ready-for-human。
  await realGitea.editLabels(repoCfg.repo, issue.number, { add: "ready-for-human", remove: "ready-for-agent" }).catch(() => {})

  if (state === "done") {
    await worktreeRemove(repoCfg.dir, wt.path)
    log(`${key}：已合并并清理工作区`)
  }
  return { state, pr }
}

// 挂起：回帖 + 打标签 + 账本记 state。
async function hold(ctx, repoCfg, issue, result, worktree, key, state) {
  const { book, log } = ctx
  const gitea = ctx.gitea ?? realGitea
  const body = holdComment({
    status: result.status,
    note: result.summary,
    question: result.question,
    worktree,
  })
  await gitea.commentIssue(repoCfg.repo, issue.number, body).catch((e) => log(`${key}：挂起留言失败：${e.message}`))
  const label = state === "needs-human" ? "ready-for-human" : state === "blocked" ? "agent-blocked" : "needs-human"
  await gitea.editLabels(repoCfg.repo, issue.number, { add: label, remove: "ready-for-agent" }).catch(() => {})
  book.setIssue(key, {
    state,
    lastFailure: result.summary || result.question || result.status,
    worktree,
  })
}

// ---- 单实例锁：一轮只允许一个进程写状态 ----

export function acquireLock(file, { staleHours = 6 } = {}) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"))
    if (d.pid && isAlive(d.pid) && Date.now() - new Date(d.at).getTime() < staleHours * 3600000) {
      return null
    }
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: nowIso() }))
  return file
}

export function releaseLock(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"))
    if (d.pid === process.pid) fs.rmSync(file, { force: true })
  } catch {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
