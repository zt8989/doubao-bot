#!/usr/bin/env node
// foreman：接单编排（opencli + dws + herdr）+ 常驻服务（会话监听与异步通知）。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { expandHome, parseArgs, sleep, truthy } from "../src/util.mjs"
import { loadConfig } from "../src/config.mjs"
import { Book } from "../src/book.mjs"
import { DwsDriver } from "../src/dwsdrv.mjs"
import { acquireLock, releaseLock, runRound, issueKey } from "../src/orchestrator.mjs"
import { git, branchExists } from "../src/gitx.mjs"
import { ensureService, callRaw, ServiceError } from "../src/svclient.mjs"
import { startServer, pingOnce } from "../src/service.mjs"

const HELP = `foreman — 接单编排 + 常驻服务

用法：
  foreman serve [--daemon] [-c <配置>]
  foreman ping [-c <配置>] [--no-service]
  foreman status [-c <配置>] [--no-service]
  foreman watch add <会话id|标题> [--notify <会话id|标题>] [--repo <owner/name> --number <N>] [-c] [--no-service]
  foreman watch list [-c] [--no-service]
  foreman watch rm <会话id|标题> [-c] [--no-service]
  foreman watch poll [-c] [--no-service]
  foreman run   [--once] [--dry-run] [--repo <名字|owner/name>] [--every <秒>] [--notify <会话id|标题>] [--no-notify] [-c <配置>]
  foreman tasks [--json]
  foreman retry <仓库名|owner/name> <工单号> [-c <配置>]
  foreman doctor [-c <配置>] [--start]
  foreman help

常驻服务：
  serve       前台起服务；--daemon 后台起，父进程等握手成功后返回
  ping/status 问服务状态
  watch add   登记一条监听（target 是会话 id 或侧边栏标题）
  watch list/rm/poll   看登记 / 删一条 / 立刻跑一轮（取证排障用）
  --no-service  跳过自动握手与拉起（逃生口）

run 现在只派活：建 worktree → dws 开会话派活 → 记账 → 登记监听 → 返回 dispatched。
不等回复、不验收、不 push/PR、不发通知；跑完由服务异步通知。
--notify <id|标题>：本轮派出去的会话通知给该目标；--no-notify：本轮不登记监听。
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

// ---- 服务命令 ----

function spawnDetached(cfg) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bin = path.resolve(here, "foreman.mjs")
  fs.mkdirSync(path.dirname(cfg.service.logFile), { recursive: true })
  const fd = fs.openSync(cfg.service.logFile, "a")
  const args = ["serve"]
  if (cfg.configPath) args.push("-c", cfg.configPath)
  const child = spawn(process.execPath, [bin, ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  child.unref()
  return child
}

async function cmdServe(pos, flags) {
  const cfg = loadConfig(flags.config)
  const log = logTo(cfg.service.logFile)

  // 已经有活的服务在跑？直接报告 already-running。
  try {
    const r = await pingOnce(cfg.service.socket, 300)
    out({ ok: true, skipped: "already-running", pid: r.pid, info: r })
    return
  } catch {}

  if (truthy(flags.daemon)) {
    const child = spawnDetached(cfg)
    const deadline = Date.now() + (cfg.service.handshakeTimeoutMs ?? 5000)
    while (Date.now() < deadline) {
      await sleep(200)
      try {
        const r = await pingOnce(cfg.service.socket, 200)
        out({ ok: true, started: true, pid: child.pid, info: r })
        return
      } catch {}
    }
    process.stderr.write("✗ foreman 服务没起来：握手超时\n")
    process.stderr.write(`  手动起看错误：foreman serve（前台）\n  看日志：cat ${cfg.service.logFile}\n`)
    process.exit(1)
  }

  // 前台：起 socket 服务，跑轮询，等信号退出。
  const book = new Book(cfg.stateFile)
  const dws = new DwsDriver({ bin: cfg.dws?.bin ?? "dws", mode: cfg.dws?.mode, model: cfg.dws?.model, log })
  const { close } = await startServer({ cfg, book, dws, log })
  log(`foreman 服务已起：pid=${process.pid} socket=${cfg.service.socket} pidfile=${cfg.service.pidFile}`)
  let stopping = false
  const onSig = async (sig) => {
    if (stopping) return
    stopping = true
    log(`收到 ${sig}，关闭服务`)
    try { await close() } catch {}
    process.exit(0)
  }
  process.on("SIGTERM", () => onSig("SIGTERM"))
  process.on("SIGINT", () => onSig("SIGINT"))
}

async function cmdPing(pos, flags) {
  const cfg = loadConfig(flags.config)
  const r = await callRaw(cfg.service.socket, { id: "cli", cmd: "ping" }, 3000)
  out({ ok: true, ...r })
}

async function cmdStatus(pos, flags) {
  const cfg = loadConfig(flags.config)
  const r = await callRaw(cfg.service.socket, { id: "cli", cmd: "status" }, 3000)
  out({ ok: true, ...r })
}

async function cmdWatch(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  if (!sub) throw new Error("用法：foreman watch add|list|rm|poll ...")
  if (sub === "list") {
    const r = await callRaw(cfg.service.socket, { id: "cli", cmd: "watch list" }, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "poll") {
    const r = await callRaw(cfg.service.socket, { id: "cli", cmd: "poll" }, 60000)
    return out({ ok: true, ...r })
  }
  if (sub === "add") {
    const target = pos.shift()
    if (!target) throw new Error("用法：foreman watch add <会话id|标题> [--notify <目标>] [--repo <owner/name> --number <N>]")
    const req = {
      id: "cli",
      cmd: "watch add",
      target,
      notifyTo: flags.notify && flags.notify !== true ? String(flags.notify) : "",
      repo: flags.repo && flags.repo !== true ? String(flags.repo) : "",
      number: flags.number && flags.number !== true ? Number(flags.number) : null,
    }
    const r = await callRaw(cfg.service.socket, req, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "rm" || sub === "remove") {
    const target = pos.shift()
    if (!target) throw new Error("用法：foreman watch rm <会话id|标题>")
    const r = await callRaw(cfg.service.socket, { id: "cli", cmd: "watch remove", target }, 3000)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 watch 子命令：${sub}（add|list|rm|poll）`)
}


// ---- 原有命令 ----

async function cmdRun(pos, flags) {
  const cfg = loadConfig(flags.config)
  if (!cfg.repos.length) throw new Error("配置里没有 repos，先写一条：{\"repo\":\"owner/name\",\"dir\":\"~/Documents/workspace/<repo>\"}")
  // --notify <目标> / --no-notify 只管本轮派出去的会话要不要登记监听。
  const notifyTo = flags.notify && flags.notify !== true ? String(flags.notify) : ""
  const noNotify = truthy(flags["no-notify"])
  const lockFile = path.join(path.dirname(cfg.stateFile), "run.lock")

  const dryRun = truthy(flags["dry-run"])
  const ctx = makeCtx(cfg, {
    dryRun,
    once: truthy(flags.once, true),
    only: flags.repo && flags.repo !== true ? String(flags.repo) : "",
    notifyTo,
    noNotify,
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
      handled: handled.map((h) => ({ repo: h.repo, number: h.number, state: h.state, branch: h.branch ?? null, convId: h.convId ?? null })),
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

  // 除 serve / help 外，所有子命令启动先握手（--no-service 或 cfg.service.enabled===false 时跳过）。
  if (!["serve", "help"].includes(cmd)) {
    const cfg = loadConfig(flags.config)
    const noService = truthy(flags["no-service"])
    if (!noService && cfg.service?.enabled !== false) {
      try {
        await ensureService({ cfg, noService: false })
      } catch (e) {
        const msg = e instanceof ServiceError ? e.message : String(e.message || e)
        process.stderr.write(`✗ foreman 服务没起来：${msg}\n`)
        process.stderr.write(`  手动起：foreman serve\n  看日志：cat ${cfg.service.logFile}\n`)
        process.exit(1)
      }
    }
  }

  switch (cmd) {
    case "serve":
      return cmdServe(pos, flags)
    case "ping":
      return cmdPing(pos, flags)
    case "status":
      return cmdStatus(pos, flags)
    case "watch":
      return cmdWatch(pos, flags)
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
