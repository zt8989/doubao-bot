#!/usr/bin/env node
// foreman：接单编排（opencli + dws + herdr）+ 常驻服务（会话监听与异步通知）。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { expandHome, parseArgs, sleep, truthy } from "../src/util.mjs"

const strFlag = (v) => (v === undefined || v === null || v === true || v === false ? "" : String(v))
import { loadConfig } from "../src/config.mjs"
import { Book } from "../src/book.mjs"
import { DwsDriver } from "../src/dwsdrv.mjs"
import { acquireLock, releaseLock, runRound, issueKey } from "../src/orchestrator.mjs"
import { git, branchExists } from "../src/gitx.mjs"
import { ensureService, callRaw, ServiceError, resolvePort, portFileOf, readPortFile } from "../src/svclient.mjs"
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
  foreman pr list [-c] [--no-service]
  foreman pr poll [-c] [--no-service]
  foreman pr open --repo R --base <基线> --head <分支> --title <标题> [--body <正文>] [--issue <单号>] [--issue-repo <工单所在仓库>]
  foreman ws add --repo <工程名|owner/name> --issue <owner/name>#<单号> [--base <基线>]
  foreman ws list --issue <owner/name>#<单号>
  foreman issue comment <N> --repo R --body <正文>
  foreman issue close <N> --repo R
  foreman run   [--once] [--dry-run] [--direct] [--repo <名字|owner/name>] [--every <秒>] [--notify <会话id|标题>] [--no-notify] [-c <配置>]
  foreman orch start [--name <会话名>]   起/复用唯一编排会话（幂等，全程只有这一条）
  foreman orch show                    看编排会话、绑了哪些工作会话、最近 steer 了什么
  foreman hand <owner/name>#<单号>      把工单交给编排会话（它再自己调 dispatch）
  foreman dispatch <owner/name>#<单号>  编排调用：建工作区 + 开工作会话，会话 id 绑回编排
  foreman resume <owner/name>#<单号>    失败/卡住：在同一条工作会话里 steer 续跑（不新开）
  foreman clean <owner/name>#<单号>     合并关单后清 worktree、本地分支、工作会话（幂等）
  foreman clean --all                  清所有终端态工单残留的工作区与会话
  foreman pickup [-c <配置>]        手动催一轮自动巡检（服务按 pickup 配置捞一轮单）
  foreman tasks [--json]
  foreman retry <仓库名|owner/name> <工单号> [-c <配置>]
  foreman doctor [-c <配置>] [--start]
  foreman help

常驻服务：
  serve       前台起服务；--daemon 后台起，父进程等握手成功后返回
  ping/status 问服务状态
  watch add   登记一条监听（target 是会话 id 或侧边栏标题）
  watch list/rm/poll   看登记 / 删一条 / 立刻跑一轮（取证排障用）
  pr list     看 PR 监听账本（哪些 PR 见过/已通知）
  pr poll     立刻扫一轮 PR（作者不是自己的（pickup.me）交编排处理）
  deliver     通知投递（老模型）：deliver.mode=new 每次新建一条会话；existing 才塞回已有会话。
              会话中心（默认 sessionFlow.enabled）不走这条：更新一律 steer 进唯一编排会话。
  pr open     建 PR（唯一入口：agent 也走它，账本/控制台才记得到）
  pr merge <N> --repo R [--issue <单号>]   合并 PR（唯一入口：先核对关联工单再合；失败回理由）
  ws add      一工程一工作区：工单跨工程时现开一个工作区（幂等），执行会话不许跨目录改
  ws list     看这条工单已经开了哪几个工程的工作区
  workflow view                            看两条流程（自有工单 / 他人 PR）的节点与累计次数
  workflow pause|resume <节点>             暂停/继续某个节点（只停这个节点，不停止整条流程）
  issue comment|close   评论/关单（可选：用它才会记账，直接 opencli gitea 也行）
  --no-service  跳过自动握手与拉起（逃生口）

run 以编排会话为中心：捞到单先交给唯一编排会话（dws steer），由它调 foreman dispatch 分配工作；
工作会话的每次状态更新都 steer 回这条编排会话，失败也用 foreman resume 在同一会话里续跑。
合并关单后由编排调 foreman clean 清 worktree 与会话。--direct 退回老行为（run 自己派活）。
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
  const probePort = readPortFile(portFileOf(cfg)) || Number(cfg.service?.http?.port) || 0
  try {
    const r = await pingOnce(probePort, 300)
    out({ ok: true, skipped: "already-running", pid: r.pid, info: r })
    return
  } catch {}

  if (truthy(flags.daemon)) {
    const child = spawnDetached(cfg)
    const deadline = Date.now() + (cfg.service.handshakeTimeoutMs ?? 5000)
    while (Date.now() < deadline) {
      await sleep(200)
      try {
        const port = readPortFile(portFileOf(cfg))
        if (!port) continue
        const r = await pingOnce(port, 200)
        out({ ok: true, started: true, pid: child.pid, port, info: r })
        return
      } catch {}
    }
    process.stderr.write("✗ foreman 服务没起来：握手超时\n")
    process.stderr.write(`  手动起看错误：foreman serve（前台）\n  看日志：cat ${cfg.service.logFile}\n`)
    process.exit(1)
  }

  // 前台：起 HTTP 服务（RPC + 控制台），跑轮询，等信号退出。
  const book = new Book(cfg.stateFile)
  const dws = new DwsDriver({ bin: cfg.dws?.bin ?? "dws", mode: cfg.dws?.mode, model: cfg.dws?.model, log })
  let started
  try {
    started = await startServer({ cfg, book, dws, log })
  } catch (e) {
    if (e.code === "already-running") {
      out({ ok: true, skipped: "already-running", error: e.message })
      return
    }
    if (e.code === "port-in-use") {
      process.stderr.write(`✗ foreman 服务没起来：${e.message}\n`)
      process.stderr.write(`  改端口：配置 service.http.port，或删掉 ${portFileOf(cfg)} 后重试\n`)
      process.exit(1)
    }
    throw e
  }
  const { close } = started
  log(`foreman 服务已起：pid=${process.pid} http=${started.http} portFile=${started.portFile}`)
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
  const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "ping" }, 3000)
  out({ ok: true, ...r })
}

async function cmdStatus(pos, flags) {
  const cfg = loadConfig(flags.config)
  const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "status" }, 3000)
  out({ ok: true, ...r })
}

async function cmdWatch(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  if (!sub) throw new Error("用法：foreman watch add|list|rm|poll ...")
  if (sub === "list") {
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "watch list" }, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "poll") {
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "poll" }, 60000)
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
    const r = await callRaw(resolvePort(cfg), req, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "rm" || sub === "remove") {
    const target = pos.shift()
    if (!target) throw new Error("用法：foreman watch rm <会话id|标题>")
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "watch remove", target }, 3000)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 watch 子命令：${sub}（add|list|rm|poll）`)
}

async function cmdPr(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  if (!sub) throw new Error("用法：foreman pr list|poll")
  if (sub === "list") {
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "pr list" }, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "poll") {
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "pr poll" }, 300000)
    return out({ ok: true, ...r })
  }
  if (sub === "open") {
    const repo = strFlag(flags.repo)
    const head = strFlag(flags.head)
    const title = strFlag(flags.title)
    // 基线不写死在命令里：没给 --base 就用配置里这条仓库的 repos[].base。
    const base = strFlag(flags.base) || (cfg.repos ?? []).find((r) => r.repo === repo)?.base || ""
    if (!repo || !base || !head || !title) throw new Error("用法：foreman pr open --repo R [--base <基线>] --head <分支> --title <标题> [--body <正文>] [--issue <单号>]（--base 不写取配置 repos[].base）")
    const r = await callRaw(resolvePort(cfg), {
      id: "cli",
      cmd: "pr open",
      repo, base, head, title,
      body: strFlag(flags.body),
      issue: Number(strFlag(flags.issue)) || 0,
      // 跨工程的单：--issue-repo 指工单所在仓库，账本记到那条单上（不写就是 PR 自己的仓库）。
      issueRepo: strFlag(flags["issue-repo"]),
    }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "merge") {
    const number = Number(pos.shift())
    const repo = strFlag(flags.repo)
    if (!number || !repo) throw new Error("用法：foreman pr merge <N> --repo R [--issue <单号>] [--style merge|rebase|squash] [--delete-branch]")
    const r = await callRaw(resolvePort(cfg), {
      id: "cli",
      cmd: "pr merge",
      repo, number,
      issue: Number(strFlag(flags.issue)) || 0,
      style: strFlag(flags.style) || undefined,
      deleteBranch: flags["no-delete-branch"] ? false : undefined,
    }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 pr 子命令：${sub}（list|poll|open|merge）`)
}

// ws：一工程一工作区。执行会话跑到一半发现还要改别的工程，用它现开一个工作区（幂等）。
async function cmdWs(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift() || "list"
  if (!["add", "list"].includes(sub)) throw new Error("用法：foreman ws add --repo <工程> --issue <owner/name>#<单号> | foreman ws list --issue <owner/name>#<单号>")
  const issue = strFlag(flags.issue)
  if (!issue) throw new Error("ws 子命令要 --issue <owner/name>#<工单号>（首句里给的「工单键」）")
  const req = { id: "cli", cmd: `ws ${sub}`, issue, repo: strFlag(flags.repo), base: strFlag(flags.base) }
  if (sub === "add" && !req.repo) throw new Error("ws add 要 --repo <工程名|owner/name>")
  const r = await callRaw(resolvePort(cfg), req, 300000)
  if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

// workflow：看两条流程的节点、暂停/继续某个节点（节点级开关，不停止整条流程）。
async function cmdWorkflow(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift() || "view"
  if (!["view", "pause", "resume"].includes(sub)) throw new Error("用法：foreman workflow view | pause <节点> | resume <节点>")
  const req = { id: "cli", cmd: "workflow", action: sub === "view" ? "view" : sub }
  if (sub !== "view") {
    const stage = String(pos.shift() ?? "").trim()
    if (!stage) throw new Error(`用法：foreman workflow ${sub} <节点>`)
    req.stage = stage
  }
  const r = await callRaw(resolvePort(cfg), req, 60000)
  if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

// ---- 原有命令 ----

async function cmdIssue(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  const repo = strFlag(flags.repo)
  const number = Number(pos[0] ?? strFlag(flags.number)) || 0
  if (!sub) throw new Error("用法：foreman issue comment <N> --repo R --body <正文> | foreman issue close <N> --repo R")
  if (!repo || !number) throw new Error("issue 子命令需要 --repo 与工单号")
  if (sub === "comment") {
    const body = strFlag(flags.body) || pos.slice(1).join(" ")
    if (!body.trim()) throw new Error("issue comment 需要 --body <正文>")
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "issue comment", repo, number, body }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "close") {
    const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "issue close", repo, number }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 issue 子命令：${sub}（comment|close）`)
}

// 手动催一轮自动巡检：服务侧按 pickup 配置捞一轮（不影响命令行 run 的锁）。
async function cmdPickup(pos, flags) {
  const cfg = loadConfig(flags.config)
  const r = await callRaw(resolvePort(cfg), { id: "cli", cmd: "pickup" }, 900000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

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
    // --direct：这一轮自己派（老行为），不交给编排会话。
    ...(truthy(flags.direct) ? { hand: false } : {}),
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
      handled: handled.map((h) => ({
        repo: h.repo,
        number: h.number,
        state: h.state,
        branch: h.branch ?? null,
        workspaces: Array.isArray(h.workspaces) ? h.workspaces.length : null,
        convId: h.convId ?? null,
      })),
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

async function cmdOrch(pos, flags) {
  const cfg = loadConfig(flags.config)
  const action = String(pos[0] ?? "show")
  if (!["start", "show"].includes(action)) throw new Error("用法：foreman orch start|show")
  const port = await resolvePort(cfg)
  const r = await callRaw(port, { id: "cli", cmd: `orch ${action}`, name: flags.name && flags.name !== true ? String(flags.name) : "" }, 600000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdHand(pos, flags) {
  const ref = String(pos[0] ?? flags.issue ?? "").trim()
  if (!ref) throw new Error("用法：foreman hand <owner/name>#<单号>")
  const cfg = loadConfig(flags.config)
  const port = await resolvePort(cfg)
  const r = await callRaw(port, { id: "cli", cmd: "hand", issue: ref }, 600000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdDispatch(pos, flags) {
  const ref = String(pos[0] ?? flags.issue ?? "").trim()
  if (!ref) throw new Error("用法：foreman dispatch <owner/name>#<单号>")
  const cfg = loadConfig(flags.config)
  const port = await resolvePort(cfg)
  // 派活要建 worktree、开工作会话（no-wait）；窗口忙时可能等一会儿，给足时间。
  const r = await callRaw(port, { id: "cli", cmd: "dispatch", issue: ref }, 900000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdResume(pos, flags) {
  const ref = String(pos[0] ?? flags.issue ?? "").trim()
  if (!ref) throw new Error("用法：foreman resume <owner/name>#<单号>（在已有工作会话里 steer 续跑）")
  const cfg = loadConfig(flags.config)
  const port = await resolvePort(cfg)
  const r = await callRaw(port, { id: "cli", cmd: "resume", issue: ref }, 600000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdClean(pos, flags) {
  const cfg = loadConfig(flags.config)
  const ref = String(pos[0] ?? flags.issue ?? "").trim()
  const all = truthy(flags.all)
  if (!ref && !all) throw new Error("用法：foreman clean <owner/name>#<单号>（或 --all）")
  const port = await resolvePort(cfg)
  const r = await callRaw(port, { id: "cli", cmd: "clean", issue: ref, all }, 900000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
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
    case "workflow":
      return cmdWorkflow(pos, flags)
    case "ws":
      return cmdWs(pos, flags)
    case "pr":
      return cmdPr(pos, flags)
    case "issue":
      return cmdIssue(pos, flags)
    case "run":
      return cmdRun(pos, flags)
    case "orch":
      return cmdOrch(pos, flags)
    case "hand":
      return cmdHand(pos, flags)
    case "dispatch":
      return cmdDispatch(pos, flags)
    case "resume":
      return cmdResume(pos, flags)
    case "clean":
      return cmdClean(pos, flags)
    case "pickup":
      return cmdPickup(pos, flags)
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
