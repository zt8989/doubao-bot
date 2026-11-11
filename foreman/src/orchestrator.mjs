// 编排：捞单 → herdr 建工作区 → dws 开会话派活 → 读 RESULT → 验收 → push/PR/合并关单。
// 三个工具各管一段：opencli 管 Gitea，herdr 管 worktree，dws 管豆包会话。
import fs from "node:fs"
import path from "node:path"
import { exec, nowIso } from "./util.mjs"
import { closeIssue, commentIssue, createPr, editLabels, listIssues, mergePr, viewIssue } from "./gitea.mjs"
import {
  commitsAhead,
  createWorktree,
  diffStat,
  pushBranch,
  recentCommits,
  statusPorcelain,
  worktreeRemove,
} from "./gitx.mjs"
import { doneComment, holdComment, issueBranch, kickoff, parseResult, prBody, resume } from "./prompts.mjs"

export const issueKey = (repo, n) => `${repo}#${n}`

// 这些状态说明这条单已经被处理过一遍，不再自动捞。
export const CLOSED_STATES = new Set(["done", "needs-human", "blocked", "escalated", "pr-open"])

export function eligible(issues, repoCfg, cfg, book) {
  const exclude = new Set((cfg.pickup.excludeLabels ?? []).map((s) => String(s).toLowerCase()))
  // labelIds 已经在服务端过滤过；此时列表里没有 labels 可用，不能再拿名字做二次过滤，
  // 否则会一条都捞不到。
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
    if (rec && rec.state === "working" && (rec.attempts ?? 0) >= cfg.maxAttempts) return false
    return true
  })
}

export function sortIssues(issues, order = "oldest") {
  const t = (x) => new Date(x.createdAt || 0).getTime()
  return [...issues].sort((a, b) => (order === "newest" ? t(b) - t(a) : t(a) - t(b)))
}

// 一轮：每个仓库各自捞、各自做，做完一条接一条。
export async function runRound(ctx) {
  const { cfg, book, log } = ctx
  const handled = []
  for (const repoCfg of cfg.repos) {
    if (ctx.only && ![repoCfg.name, repoCfg.repo].includes(ctx.only)) continue
    if (ctx.dryRun) log(`[dry-run] 看 ${repoCfg.repo} 的待接工单（不会建工作区、不会动会话）`)

    const labelQuery = (repoCfg.labelIds ?? cfg.pickup.labelIds ?? []).join(",")
    let list = []
    try {
      list = await listIssues(repoCfg.repo, { label: labelQuery })
    } catch (e) {
      log(`拉 ${repoCfg.repo} 的工单失败，跳过这个仓库：${e.message}`)
      continue
    }
    const pool = sortIssues(eligible(list, repoCfg, cfg, book), cfg.pickup.order)
    log(`${repoCfg.repo}：open ${list.length} 条，可接 ${pool.length} 条`)

    let count = 0
    for (const it of pool) {
      if (count >= cfg.perRepoPerRound) break
      count++
      try {
        handled.push(await handleIssue(ctx, repoCfg, it))
      } catch (e) {
        if (e.code === "app_unavailable") throw e
        log(`${repoCfg.repo} #${it.number} 处理失败：${e.message}`)
        handled.push({ repo: repoCfg.repo, number: it.number, state: "failed", reason: e.message })
      }
    }
    if (ctx.once) break
  }
  return handled
}

export async function handleIssue(ctx, repoCfg, summary) {
  const { cfg, book, dws, log } = ctx
  const key = issueKey(repoCfg.repo, summary.number)
  const prev = book.issue(key) ?? {}
  const name = `foreman-${repoCfg.name}-${summary.number}`

  const issue = await viewIssue(repoCfg.repo, summary.number)
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

  let attempt = prev.attempts ?? 0
  let lastFailure = prev.lastFailure ?? ""

  while (attempt < cfg.maxAttempts) {
    attempt++
    book.setIssue(key, {
      state: "working",
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      branch,
      worktree: wt.path,
      attempts: attempt,
      lastFailure,
    })

    let text = ""
    try {
      if (book.session(name)?.convId) {
        log(`${key}：第 ${attempt} 次，续会话 ${name}`)
        await dws.send(name, resume({ issue, attempt, failure: lastFailure }))
      } else {
        log(`${key}：第 ${attempt} 次，开新会话 ${name}`)
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
            lastFailure,
          }),
        })
        book.record(name, { convId: opened.convId ?? "", issue: issue.number })
      }
      await dws.waitFinished(name, {
        timeoutMs: cfg.timeoutMinutes * 60000,
        pollMs: cfg.pollSeconds * 1000,
        onTick: (s) => log(`  ${name}：${s?.reply?.streaming ? "还在生成" : s?.reply?.finished ? "已跑完" : "还没开始"}（${s?.reply?.chars ?? 0} 字）`),
      })
      const info = await dws.info(name)
      text = info.lastReply || ""
      book.record(name, { lastReply: text.slice(-4000) })
    } catch (e) {
      if (e.code === "app_unavailable") {
        book.setIssue(key, { state: "blocked", lastFailure: e.message })
        throw e
      }
      lastFailure = `会话没跑通：${e.message}`
      book.setIssue(key, { lastFailure })
      log(`${key}：${lastFailure}`)
      continue
    }

    const result = parseResult(text)

    if (result.status === "done") {
      const check = await verify(ctx, wt.path, repoCfg)
      if (!check.ok) {
        lastFailure = check.why
        book.setIssue(key, { lastFailure })
        log(`${key}：验收没过 —— ${lastFailure}`)
        continue
      }
      const pub = await publish(ctx, repoCfg, issue, { ...wt, path: wt.path }, result, check, key)
      book.setIssue(key, {
        state: pub.state,
        pr: pub.pr?.number ?? null,
        prUrl: pub.pr?.url ?? "",
        lastFailure: "",
        finishedAt: nowIso(),
      })
      log(`${key}：${pub.state}${pub.pr?.number ? `，PR #${pub.pr.number}` : ""}`)
      return { repo: repoCfg.repo, number: issue.number, state: pub.state, branch, pr: pub.pr?.number ?? null }
    }

    if (result.status === "need_decision" || result.status === "blocked") {
      const state = result.status === "need_decision" ? "needs-human" : "blocked"
      await hold(ctx, repoCfg, issue, result, wt.path, key, state)
      log(`${key}：${state} —— ${result.question || result.summary || "（没写原因）"}`)
      return { repo: repoCfg.repo, number: issue.number, state, reason: result.summary || result.question }
    }

    lastFailure = result.status === "none" ? "会话结束但没有交 RESULT 块" : result.summary || "RESULT 说 failed"
    book.setIssue(key, { lastFailure })
    log(`${key}：第 ${attempt} 次没成 —— ${lastFailure}`)
  }

  await hold(ctx, repoCfg, issue, { status: "failed", summary: `试了 ${attempt} 次没成：${lastFailure}` }, wt.path, key, "escalated")
  return { repo: repoCfg.repo, number: issue.number, state: "escalated", reason: lastFailure }
}

// 验收三条：工作区干净、分支有提交、配置里的 verify 命令全过。
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

async function publish(ctx, repoCfg, issue, wt, result, check, key) {
  const { cfg, log } = ctx
  const commits = await recentCommits(wt.path, repoCfg.base)
  const stat = await diffStat(wt.path, repoCfg.base)

  await pushBranch(wt.path, wt.branch)
  log(`${key}：已 push ${wt.branch}`)

  const pr = await createPr({
    repo: repoCfg.repo,
    base: repoCfg.base,
    head: wt.branch,
    title: `fix(#${issue.number}): ${issue.title}`,
    body: prBody({ issue, summary: result.summary, tests: result.tests, commits, stat, base: repoCfg.base }),
  })
  log(`${key}：PR ${pr.number ? `#${pr.number}` : "已创建（没拿到编号）"}`)

  let state = "pr-open"
  if (cfg.merge?.enabled) {
    await mergePr(repoCfg.repo, pr.number, {
      style: cfg.merge.style ?? "merge",
      deleteBranch: cfg.merge.deleteBranch !== false,
    })
    await closeIssue(repoCfg.repo, issue.number)
    state = "done"
  }

  await commentIssue(repoCfg.repo, issue.number, doneComment({ pr, tests: result.tests, summary: result.summary })).catch(
    (e) => log(`${key}：回帖工单失败（不影响主流程）：${e.message}`)
  )
  await editLabels(repoCfg.repo, issue.number, { remove: "ready-for-agent" }).catch(() => {})

  if (state === "done") {
    await worktreeRemove(repoCfg.dir, wt.path)
    log(`${key}：已合并并清理工作区`)
  }
  return { state, pr }
}

async function hold(ctx, repoCfg, issue, result, worktree, key, state) {
  const { book, log } = ctx
  const body = holdComment({
    status: result.status,
    note: result.summary,
    question: result.question,
    worktree,
  })
  await commentIssue(repoCfg.repo, issue.number, body).catch((e) => log(`${key}：挂起留言失败：${e.message}`))
  const label = state === "needs-human" ? "ready-for-human" : state === "blocked" ? "agent-blocked" : "needs-human"
  await editLabels(repoCfg.repo, issue.number, { add: label, remove: "ready-for-agent" }).catch(() => {})
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
