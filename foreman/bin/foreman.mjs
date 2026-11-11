#!/usr/bin/env node
// foreman：接单编排。opencli 管 Gitea、herdr 管 worktree、dws 管豆包会话。
import fs from "node:fs"
import path from "node:path"
import { expandHome, parseArgs, sleep, truthy } from "../src/util.mjs"
import { loadConfig } from "../src/config.mjs"
import { Book } from "../src/book.mjs"
import { DwsDriver } from "../src/dwsdrv.mjs"
import { acquireLock, releaseLock, runRound, issueKey } from "../src/orchestrator.mjs"
import { git, branchExists } from "../src/gitx.mjs"

const HELP = `foreman — 接单编排（opencli + dws + herdr）

用法：
  foreman run   [--once] [--dry-run] [--repo <名字|owner/name>] [--every <秒>] [--notify <会话id|标题>] [--no-notify] [-c <配置>]
  foreman tasks [--json]
  foreman retry <仓库名|owner/name> <工单号> [-c <配置>]
  foreman doctor [-c <配置>] [--start]
  foreman help

run       跑一轮（--once 只跑一轮；--dry-run 只打印计划，零副作用）
tasks     看每条工单处理到哪一步
retry     人工处理完，把工单放回队列（attempts 清零）
doctor    自检：dws / opencli / herdr / 各仓库与基线（--start 才真的拉起豆包）

每轮流程：对每条 ready-for-agent 的工单——
  1. opencli 读工单；
  2. herdr 从 origin/<base> 开 worktree（分支 fix/issue-N）；
  3. dws 开会话把活派出去，等它交 <RESULT>；
  4. 验收：工作区干净 + 有提交 + verify 命令全过；
  5. push → opencli 开 PR；（配置 merge.enabled 时）合并并关单；
  6. 卡住/要人拍板的，回帖工单 + 打标签，工作区留着等 retry。
`

const out = (o) => {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n")
}

function logTo(file) {
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    process.stderr.write(line)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line)
    } catch {}
  }
}

function makeCtx(cfg, extra = {}) {
  const log = logTo(path.join(path.dirname(cfg.stateFile), "run.log"))
  return {
    cfg,
    book: new Book(cfg.stateFile),
    dws: new DwsDriver({ bin: cfg.dws?.bin ?? "dws", mode: cfg.dws?.mode, model: cfg.dws?.model, log }),
    log,
    ...extra,
  }
}

async function cmdRun(pos, flags) {
  const cfg = loadConfig(flags.config)
  if (!cfg.repos.length) throw new Error("配置里没有 repos，先写一条：{\"repo\":\"owner/name\",\"dir\":\"~/Documents/workspace/<repo>\"}")
  // 命令行覆盖配置：--notify <会话id|标题> / --no-notify
  if (flags.notify && flags.notify !== true) cfg.notify = { ...cfg.notify, session: String(flags.notify) }
  if (truthy(flags["no-notify"])) cfg.notify = { ...cfg.notify, enabled: false }
  const lockFile = path.join(path.dirname(cfg.stateFile), "run.lock")

  const dryRun = truthy(flags["dry-run"])
  const ctx = makeCtx(cfg, {
    dryRun,
    once: truthy(flags.once, true),
    only: flags.repo && flags.repo !== true ? String(flags.repo) : "",
  })

  if (!dryRun) {
    const lock = acquireLock(lockFile)
    if (!lock) {
      out({ ok: true, skipped: "locked", note: `另一轮还在跑（${lockFile}），这轮跳过` })
      return
    }
  }

  try {
    const handled = []
    do {
      const round = await runRound(ctx)
      handled.push(...round)
      if (!flags.every || flags.every === true) break
      const every = Number(flags.every)
      if (!Number.isFinite(every) || every <= 0) break
      ctx.log(`这一轮结束，${every}s 后跑下一轮`)
      await sleep(every * 1000)
    } while (!ctx.once)

    out({
      ok: true,
      dryRun,
      handled: handled.map((h) => ({ repo: h.repo, number: h.number, state: h.state, pr: h.pr ?? null })),
      summary: summarize(handled),
    })
  } catch (e) {
    out({ ok: false, error: e.code ?? "error", message: e.message })
    process.exitCode = 1
  } finally {
    if (!dryRun) releaseLock(lockFile)
  }
}

function summarize(handled) {
  const counts = {}
  for (const h of handled) counts[h.state] = (counts[h.state] ?? 0) + 1
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`)
  return parts.length ? parts.join("，") : "没有可接的工单"
}

function cmdTasks(pos, flags) {
  const cfg = loadConfig(flags.config)
  const book = new Book(cfg.stateFile)
  const list = Object.entries(book.issues).map(([key, v]) => ({
    key,
    number: v.issue,
    title: v.title ?? "",
    state: v.state ?? "",
    attempts: v.attempts ?? 0,
    branch: v.branch ?? "",
    pr: v.pr ?? null,
    lastFailure: v.lastFailure ?? "",
    updatedAt: v.updatedAt ?? "",
  }))
  if (flags.json) return out({ ok: true, issues: list })
  if (!list.length) return process.stdout.write("还没有处理过工单。\n")
  for (const it of list) {
    process.stdout.write(
      `${it.key} · ${it.state}（第 ${it.attempts} 次）${it.pr ? ` PR #${it.pr}` : ""}\n` +
        (it.title ? `  ${it.title}\n` : "") +
        (it.lastFailure ? `  卡在：${it.lastFailure}\n` : "")
    )
  }
}

function cmdRetry(pos, flags) {
  const target = pos[0]
  const n = pos[1]
  if (!target || !n) throw new Error("用法：foreman retry <仓库名|owner/name> <工单号>")
  const cfg = loadConfig(flags.config)
  const book = new Book(cfg.stateFile)
  const repoCfg = cfg.repos.find((r) => r.name === target || r.repo === target)
  if (!repoCfg) throw new Error(`配置里没有这个仓库：${target}`)
  const key = issueKey(repoCfg.repo, Number(n))
  if (!book.issue(key)) throw new Error(`没处理过这条：${key}`)
  book.setIssue(key, { state: "reset", attempts: 0, lastFailure: "", pr: null, prUrl: "" })
  out({ ok: true, key, state: "reset" })
}

async function cmdDoctor(pos, flags) {
  const cfg = loadConfig(flags.config)
  const checks = []

  const binCheck = async (name, args = ["--version"]) => {
    try {
      const { exec } = await import("../src/util.mjs")
      const r = await exec(name, args, { timeout: 30000 })
      return { ok: true, detail: r.stdout.trim().split("\n")[0] }
    } catch (e) {
      return { ok: false, detail: String(e.stderr || e.message).slice(0, 200) }
    }
  }

  const dws = await binCheck(cfg.dws?.bin ?? "dws")
  checks.push({ name: "dws", ...dws })
  const opencli = await binCheck("opencli", ["--version"])
  checks.push({ name: "opencli", ...opencli })
  const herdr = await binCheck(cfg.herdr?.bin ?? "herdr", ["--version"])
  checks.push({ name: "herdr", ...herdr })

  for (const r of cfg.repos) {
    const dir = expandHome(r.dir)
    if (!fs.existsSync(path.join(dir, ".git"))) {
      checks.push({ name: `repo ${r.repo}`, ok: false, detail: `不是 git 仓库：${dir}` })
      continue
    }
    let base = { ok: false, detail: "" }
    try {
      await git(["rev-parse", "--verify", `refs/remotes/origin/${r.base}`], { cwd: dir })
      base = { ok: true, detail: `origin/${r.base} 存在` }
    } catch {
      base = { ok: false, detail: `没有 origin/${r.base}，换基线或先 fetch` }
    }
    checks.push({ name: `repo ${r.repo}`, ...base, dir })
  }

  if (truthy(flags.start)) {
    const ctx = makeCtx(cfg)
    try {
      await ctx.dws.status("foreman-doctor-probe")
      checks.push({ name: "dws 窗口/登录", ok: true, detail: "能读到窗口状态" })
    } catch (e) {
      checks.push({ name: "dws 窗口/登录", ok: false, detail: e.message })
    }
  }

  const ok = checks.every((c) => c.ok)
  out({ ok, checks, config: cfg.configPath || "（用默认值）" })
  if (!ok) process.exitCode = 1
}

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || ["-h", "--help", "help"].includes(argv[0])) return process.stdout.write(HELP)
  const { pos, flags } = parseArgs(argv, { c: "config" })
  const cmd = pos.shift()
  switch (cmd) {
    case "run":
      return cmdRun(pos, flags)
    case "tasks":
      return cmdTasks(pos, flags)
    case "retry":
      return cmdRetry(pos, flags)
    case "doctor":
      return cmdDoctor(pos, flags)
    case "help":
      return process.stdout.write(HELP)
    default:
      throw new Error(`未知命令：${cmd}（foreman help 看用法）`)
  }
}

main().catch((e) => {
  process.stderr.write(`✗ ${e.message}\n`)
  process.exit(1)
})
