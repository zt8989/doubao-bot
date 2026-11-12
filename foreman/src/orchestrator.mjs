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
import { doneComment, holdComment, issueBranch, kickoff, prBody, resume } from "./prompts.mjs"
import { startOperation, finishOperation } from "./operations.mjs"

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
  if (out.pr) lines.push(`PR：#${out.pr}${out.prUrl ? ` ${out.prUrl}` : ""}`)
  if (out.merged) lines.push(`合并：已合并 PR #${out.pr}`)
  else if (out.mergeQueued) lines.push(`合并：已排入合并通道（1 并发），合完单独通知`)
  else if (out.mergeError) lines.push(`合并失败：${String(out.mergeError).slice(0, 200)}`)
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
  // 没有 RESULT 时把执行会话的最后一条回复贴出来：编排侧不用猜它卡在哪。
  if (out.lastReply) {
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
export async function runRound(ctx) {
  const { cfg, book, log } = ctx
  const gitea = ctx.gitea ?? realGitea
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
      const op = ctx.dryRun ? 0 : startOperation(ctx, "dispatch", `派单 ${key}`, {
        key,
        detail: it.title || "读工单、准备工作区并启动执行会话",
      })
      try {
        out = await handleIssue(ctx, repoCfg, it)
        const success = out.state === "dispatched" || out.state === "planned"
        finishOperation(ctx, op, success ? "success" : "failed", out.convId ? `已派出到执行会话 · 分支 ${out.branch || "-"}` : out.reason || out.state)
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

// 派活：读工单 → 建/复用 worktree → 记账 working → dws.open/send 派出去 → 记账会话 → 登记监听。
// 返回 { repo, number, state:"dispatched", branch, convId }。不 waitFinished、不 info、不验收、不 PR。
export async function handleIssue(ctx, repoCfg, summary) {
  const { cfg, book, dws, log } = ctx
  const gitea = ctx.gitea ?? realGitea
  const key = issueKey(repoCfg.repo, summary.number)
  const prev = book.issue(key) ?? {}
  const name = `foreman-${repoCfg.name}-${summary.number}`

  const issue = await gitea.viewIssue(repoCfg.repo, summary.number)
  issue.number = summary.number
  issue.title ||= summary.title
  issue.url ||= summary.url

  const branch = prev.branch || issueBranch(issue, issue.title)
  const wtPath = path.join(cfg.worktreeDir, repoCfg.name, branch.replace(/\//g, "-"))

  // dry-run：只打印会建在哪、会发什么，零副作用。
  if (ctx.dryRun) {
    const prompt = kickoff({
      repo: repoCfg.repo,
      issue,
      worktree: wtPath,
      branch,
      base: repoCfg.base,
      attempt: (prev.attempts ?? 0) + 1,
      lastFailure: prev.lastFailure ?? "",
    })
    log(`[dry-run] ${key}\n  工作区：${wtPath}\n  分支：${branch}（基线 origin/${repoCfg.base}）\n  会话：${name}\n  首句：\n${prompt}`)
    return { repo: repoCfg.repo, number: issue.number, state: "planned", branch, worktree: wtPath, prompt }
  }

  let wt
  try {
    wt = await createWorktree({
      repoDir: repoCfg.dir,
      worktreeDir: path.join(cfg.worktreeDir, repoCfg.name),
      branch,
      base: repoCfg.base,
      herdrBin: cfg.herdr?.bin ?? "herdr",
      useHerdr: cfg.herdr?.enabled !== false,
      log,
    })
    log(`${key}：工作区 ${wt.path}（${wt.reused ? "复用" : `新建·${wt.backend}`}）`)
  } catch (e) {
    await hold(ctx, repoCfg, issue, {
      status: "blocked",
      summary: `工作区准备失败：${e.message}`,
      question: "",
    }, wtPath, key)
    return { repo: repoCfg.repo, number: issue.number, state: "blocked", reason: "workspace" }
  }

  const attempt = (prev.attempts ?? 0) + 1
  book.setIssue(key, {
    state: "working",
    agent: name,
    issue: issue.number,
    title: issue.title,
    url: issue.url,
    branch,
    worktree: wt.path,
    attempts: attempt,
    lastFailure: "",
  })

  // 派活：有 convId 就 send 续会话，否则 open 新开。dws 自身会等第一轮回复，那是 dws 的语义。
  let convId = book.session(name)?.convId ?? ""
  try {
    if (convId) {
      log(`${key}：续会话 ${name}（attempt ${attempt}）`)
      await dws.send(name, resume({ issue, attempt, base: repoCfg.base, failure: prev.lastFailure ?? "" }))
    } else {
      log(`${key}：开新会话 ${name}（attempt ${attempt}）`)
      const opened = await dws.open({
        name,
        repo: repoCfg.repo,
        prompt: kickoff({
          repo: repoCfg.repo,
          issue,
          worktree: wt.path,
          branch,
          base: repoCfg.base,
          attempt,
          lastFailure: prev.lastFailure ?? "",
        }),
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

  // --no-notify：不登记监听，同时 book.record 标 notify:false，免得被 sessions 自动纳入规则捞回来。
  const noNotify = !!ctx.noNotify
  book.record(name, { convId, issue: issue.number, notify: noNotify ? false : true })

  if (!noNotify && convId) {
    book.setWatch({
      target: convId,
      name,
      issueKey: key,
      repo: repoCfg.repo,
      number: issue.number,
      notifyTo: ctx.notifyTo ?? "",
    })
  }

  log(`${key}：已派活 → ${convId || name}${noNotify ? "（不登记监听）" : ""}`)
  return { repo: repoCfg.repo, number: issue.number, state: "dispatched", branch, convId }
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
  await realGitea.editLabels(repoCfg.repo, issue.number, { remove: "ready-for-agent" }).catch(() => {})

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
