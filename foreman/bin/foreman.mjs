#!/usr/bin/env node
// foreman：接单编排（gitea REST + dws + herdr）+ 常驻服务（会话监听与异步通知）。
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
import { ensureService, callRaw, ServiceError, resolvePort, resolveTarget, portFileOf, readPortFile } from "../src/svclient.mjs"
import { startServer, pingOnce } from "../src/service.mjs"
import { sessionTasks, formatSessionTasks } from "../src/tasktree.mjs"
import { makeSessionAdapter } from "../src/workflow/adapters/session.mjs"
import { MemoryStore } from "../src/core/memory.mjs"
import { dreamOnce } from "../src/dreaming.mjs"

const HELP = `foreman — 接单编排 + 常驻服务

用法：
  foreman serve [--daemon] [-c <配置>]
  foreman ping [-c <配置>] [--no-service]
  foreman status [-c <配置>] [--no-service]
  foreman watch add <会话id|标题> [--notify <会话id|标题>] [--repo <owner/name> --number <N>] [-c] [--no-service]
  foreman watch list [-c] [--no-service]
  foreman watch rm <会话id|标题> [-c] [--no-service]
  foreman watch poll [-c] [--no-service]
  foreman hand <owner/name>#<N> [--fresh]   --fresh 强制重派这条单的独立编排
  foreman route                            立即写入 router agent Inbox，由 Worker 投递
  foreman inbox list [--limit <N>]        看事件、Schedule 与 pending/done/dropped 计数
  foreman worker run                       手动让 Worker 消费一轮（排障用）
  foreman issue settle <N> --repo R --note <完成依据>   仅本地完成，不关远端、不清工作区
  foreman pr list [-c] [--no-service]
  foreman pr poll [-c] [--no-service]
  foreman pr ui-assign <N> --repo R        本人 UI PR 轮询指派测试验收人
  foreman pr assign <N> --repo R           路由智能体分配一条他人 PR 给合并助手
  foreman pr open --repo R --base <基线> --head <分支> --title <标题> [--body <正文>] [--issue <单号>] [--issue-repo <工单所在仓库>] [--ui]
  foreman pr merge <N> --repo R [--issue <单号>] [--style merge|rebase|squash] [--approved-by <人>] [--ui]
  foreman send --type mail --to <邮箱>[,...] --subject <主题> [--body <正文>] [--session-id <会话ID>]
  foreman send --type lark (--chat-id <oc_...>|--user-id <ou_...>) (--text <正文>|--markdown <正文>)
  foreman outbox list [--limit <N>] [--status <状态>] [--channel mail|lark]
  foreman outbox run                       手动让 Dispatcher 消费一轮（排障用）
  foreman memory show                     查看精简核心记忆 MEMORY.md / USER.md
  foreman memory set --target memory|user --key <稳定键> --text <一条记忆>
  foreman memory forget --target memory|user --key <稳定键>
  foreman memory note --text <日常观察>      写入当天日记，不自动注入
  foreman memory search <查询词> [--limit N] 按需检索核心记忆与日记
  foreman memory dream [--day YYYY-MM-DD] [--force]  整理前一日或指定日记（默认前一日）
  foreman memory dream-status              查看 dreaming 状态与 DREAMS.md 位置
  foreman memory dream-report --day D --run ID --text <摘要>  写入审阅报告并完成本轮
  foreman mail request <owner/repo>#<N> [--url <PR链接>] [--issue <owner/repo>#<N> --title <标题>]
  foreman mail poll
  foreman mail requests
  foreman mail approve <owner/repo>#<N> [--by <人>] [--note <说明>]
  foreman mail reject  <owner/repo>#<N> [--by <人>] [--note <原因>]
  foreman ws add --repo <工程名|owner/name> --issue <owner/name>#<单号> [--base <基线>]
  foreman ws list --issue <owner/name>#<单号>
  foreman issue create --repo R --title <标题> [--body <正文>] [--ws]
                                      一条龙起点：建单 + 账本建档；--ws 立即开工单所在仓的工作区
  foreman issue comment <N> --repo R --body <正文>
  foreman issue close <N> --repo R
  foreman run   [--once] [--dry-run] [--repo <名字|owner/name>] [-c <配置>]    # 扫描可接工单，逐条投 router
  foreman orch show                    看每条编排会话绑了哪些工作会话、最近 steer 了什么
  foreman hand <owner/name>#<单号>           把工单投给 router agent（唯一编排者，接单入口）
  foreman clean <owner/name>#<单号>     合并关单后清 worktree、本地分支、工作会话与这张单的编排会话（幂等）
  foreman clean --all                  清所有终端态工单残留的工作区与会话
  foreman pickup [-c <配置>]        手动催一轮自动巡检（服务按 pickup 配置捞一轮单）
  foreman tasks [--json]                    已分配会话的实时状态与父子树（工单仅作节点元数据）
  foreman retry <仓库名|owner/name> <工单号> [-c <配置>]
  foreman doctor [-c <配置>] [--start]
  foreman help

常驻服务：
  serve       前台起服务；--daemon 后台起，父进程等握手成功后返回
  ping/status 问服务状态
  watch add   登记一条监听（target 是会话 id 或侧边栏标题）
  watch list/rm/poll   看登记 / 删一条 / 立刻跑一轮（取证排障用）
  pr list     看 PR 监听账本（哪些 PR 见过/已通知）
  pr poll     立刻扫一轮 PR，把他人候选与本人 UI 候选写入路由智能体 Inbox
  pr ui-assign <N> --repo R  本人 UI PR 轮询指派给周晓亮/张振豪（只指派，不合）
  pr assign <N> --repo R   路由智能体核对候选后，显式创建这条 PR 的合并助手
  deliver     旧投递模型保留；当前任务状态统一经 task.update Inbox，由 Worker queue 给所属编排。
  pr open     建 PR（唯一入口：agent 也走它，账本/控制台才记得到）
  pr merge <N> --repo R [--issue <单号>]   合并 PR（唯一入口：先核对关联工单再合；失败回理由）
               --approved-by <人>  用户当面验收过、明确回了「合并」时带上；UI PR 的邮件验收闸门认这条
               --ui                声明这条 PR 改了界面（不写就按 worktree diff 自动认）
  mail        UI 验收邮件：PR 涉及 UI 时发信给 testers（主题末尾 [FM-…] 是筛选 ID），
              服务按筛选 ID 把回复认回这张单、注回它的编排会话，收到「验收通过」就地合并。
              send / request / poll / requests / approve / reject（详见 README「邮件验收」）
  ws add      一工程一工作区：工单跨工程时现开一个工作区（幂等），执行会话不许跨目录改
  ws list     看这条工单已经开了哪几个工程的工作区
  workflow view                            看两条流程（自有工单 / 他人 PR）的节点与累计次数
  workflow pause|resume <节点>             暂停/继续某个节点（只停这个节点，不停止整条流程）
  issue comment|close   评论/关单（可选：用它才会记账，直接 gitea 也行）
  --no-service  跳过自动握手与拉起（逃生口）

测试环境：
  FOREMAN_CONFIG_DIR=<目录> foreman serve
              从该目录读取 config.json；未显式配置的 state、SQLite、pid、日志、端口文件与记忆目录都隔离到该目录。
              监听端口仍由 config.json 的 service.http.port 配置；显式 -c <配置> 优先于环境目录。

run 以主智能体为中心：捞到单先交给本单主智能体，由它在 Agent 内部创建编码与对抗审查 sub agent；
两个内部 sub agent 的结果直接返回主智能体，不经 Foreman 工作会话。主智能体原样汇总审查、通知验收并维护状态，
合并关单后由主智能体调 foreman clean。--direct 退回旧外部会话行为（需 agent）。

执行载体（配置 agent）：dws = 豆包桌面端（默认）；noop = 不开会话、不碰豆包——clean/tasks/ws/pr/issue
照常工作，派单与投递「成功」但无人干活，inbox 只记账。豆包只是可选 agent 之一，换载体不改命令。

主智能体从哪来：
  1. 路由智能体接单：hand 按工单新建/复用独立主智能体；
  2. 用户自主发起：发起那条会话自己就是主智能体，hand 自动取 MCP_VM_CONVERSATION_ID
     （或显式 --orchestrator <会话id|标题>，--no-orchestrator 关掉自动识别）。
  编码与对抗审查 sub agent 由主智能体在 Agent 内部创建，结果直接返回，不登记为外部工作会话。
--notify <id|标题> 与 --no-notify 只服务旧外部会话监听。
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
    dws: makeSessionAdapter(cfg, { log }),
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
  const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "ping" }, 3000)
  out({ ok: true, ...r })
}

async function cmdStatus(pos, flags) {
  const cfg = loadConfig(flags.config)
  const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "status" }, 3000)
  out({ ok: true, ...r })
}

async function cmdWatch(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  if (!sub) throw new Error("用法：foreman watch add|list|rm|poll ...")
  if (sub === "list") {
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "watch list" }, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "poll") {
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "poll" }, 60000)
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
      ...callerOrchestratorArg(flags),
    }
    const r = await callRaw(resolveTarget(cfg), req, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "rm" || sub === "remove") {
    const target = pos.shift()
    if (!target) throw new Error("用法：foreman watch rm <会话id|标题>")
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "watch remove", target }, 3000)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 watch 子命令：${sub}（add|list|rm|poll）`)
}

async function cmdPr(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  if (!sub) throw new Error("用法：foreman pr list|poll|ui-assign|assign|open|merge")
  if (sub === "list") {
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "pr list" }, 3000)
    return out({ ok: true, ...r })
  }
  if (sub === "poll") {
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "pr poll" }, 300000)
    return out({ ok: true, ...r })
  }
  if (sub === "ui-assign") {
    const number = Number(pos.shift())
    const repo = strFlag(flags.repo)
    if (!number || !repo) throw new Error("用法：foreman pr ui-assign <N> --repo R")
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "pr ui-assign", repo, number }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "assign") {
    const number = Number(pos.shift())
    const repo = strFlag(flags.repo)
    if (!number || !repo) throw new Error("用法：foreman pr assign <N> --repo R")
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "pr assign", repo, number }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "open") {
    const repo = strFlag(flags.repo)
    const head = strFlag(flags.head)
    const title = strFlag(flags.title)
    // 基线不写死在命令里：没给 --base 就用配置里这条仓库的 repos[].base。
    const base = strFlag(flags.base) || (cfg.repos ?? []).find((r) => r.repo === repo)?.base || ""
    if (!repo || !base || !head || !title) throw new Error("用法：foreman pr open --repo R [--base <基线>] --head <分支> --title <标题> [--body <正文>] [--issue <单号>]（--base 不写取配置 repos[].base）")
    const r = await callRaw(resolveTarget(cfg), {
      id: "cli",
      cmd: "pr open",
      repo, base, head, title,
      body: strFlag(flags.body),
      issue: Number(strFlag(flags.issue)) || 0,
      // 跨工程的单：--issue-repo 指工单所在仓库，账本记到那条单上（不写就是 PR 自己的仓库）。
      issueRepo: strFlag(flags["issue-repo"]),
      // 显式声明改了 UI；不写就由服务按 worktree diff 自动认。
      ui: flags.ui === true,
    }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "merge") {
    const number = Number(pos.shift())
    const repo = strFlag(flags.repo)
    if (!number || !repo) throw new Error("用法：foreman pr merge <N> --repo R [--issue <单号>] [--style merge|rebase|squash] [--delete-branch]")
    const r = await callRaw(resolveTarget(cfg), {
      id: "cli",
      cmd: "pr merge",
      repo, number,
      issue: Number(strFlag(flags.issue)) || 0,
      style: strFlag(flags.style) || undefined,
      deleteBranch: flags["no-delete-branch"] ? false : undefined,
      // 用户当面验收过、明确回了「合并」：带上 --approved-by <人>，UI 验收闸门认这条。
      approvedBy: strFlag(flags["approved-by"]),
      ui: flags.ui === true,
    }, 600000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 pr 子命令：${sub}（list|poll|ui-assign|assign|open|merge）`)
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
  const r = await callRaw(resolveTarget(cfg), req, 300000)
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
  const r = await callRaw(resolveTarget(cfg), req, 60000)
  if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

// ---- 原有命令 ----

async function cmdIssue(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift()
  const repo = strFlag(flags.repo)
  const number = Number(pos[0] ?? strFlag(flags.number)) || 0
  if (!sub) throw new Error("用法：foreman issue create --repo R --title <标题> [--body <正文>] [--ws]\n      foreman issue comment <N> --repo R --body <正文> | foreman issue close <N> --repo R")
  if (sub === "create") {
    const title = (strFlag(flags.title) || pos.join(" ")).trim()
    if (!repo || !title) throw new Error("issue create 需要 --repo <owner/name> 与 --title <标题>")
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "issue create", repo, title, body: strFlag(flags.body) }, 60000)
    if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
    let ws = null
    if (truthy(flags.ws)) {
      // 一条龙：建完单立刻开工单所在仓的工作区（该仓要在配置 repos[] 里）。
      ws = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "ws add", issue: r.key, repo }, 300000)
      if (!ws.ok) throw new Error(`ws add 失败：${ws.error ?? "error"}：${ws.message ?? ""}`)
    }
    return out({ ok: true, ...r, ...(ws ? { ws: { repo: ws.repo, branch: ws.branch, worktree: ws.worktree } } : {}) })
  }
  if (!repo || !number) throw new Error("issue 子命令需要 --repo 与工单号")
  if (sub === "comment") {
    const body = strFlag(flags.body) || pos.slice(1).join(" ")
    if (!body.trim()) throw new Error("issue comment 需要 --body <正文>")
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "issue comment", repo, number, body }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "settle") {
    const note = strFlag(flags.note).trim()
    if (!note) throw new Error("issue settle 需要 --note <完成依据>；它只改本地账本，不关远端、不清工作区")
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "issue settle", repo, number, note }, 60000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  if (sub === "close") {
    const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "issue close", repo, number }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }
  throw new Error(`未知 issue 子命令：${sub}（create|comment|close）`)
}

// 手动催一轮自动巡检：服务侧按 pickup 配置捞一轮（不影响命令行 run 的锁）。
async function cmdPickup(pos, flags) {
  const cfg = loadConfig(flags.config)
  const r = await callRaw(resolveTarget(cfg), { id: "cli", cmd: "pickup" }, 900000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdRun(pos, flags) {
  if (flags.every !== undefined) throw new Error("run --every 已移除：派单一律投 router agent，由它决策接单")
  if (truthy(flags.direct)) throw new Error("run --direct 已移除：foreman 不再直接派 agent，派单请求一律投 router")
  const cfg = loadConfig(flags.config)
  if (!cfg.repos.length) throw new Error("配置里没有 repos，先写一条：{\"repo\":\"owner/name\",\"dir\":\"~/Documents/workspace/<repo>\"}")
  const dryRun = truthy(flags["dry-run"])
  // runRound 需要 ctx.routeIssue（写 router Inbox），所以 run 必须在服务里跑。
  const r = await callRaw(resolveTarget(cfg), {
    id: "cli", cmd: "run",
    only: flags.repo && flags.repo !== true ? String(flags.repo) : "",
    dryRun,
  }, 900000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  const handled = Array.isArray(r.handled) ? r.handled : []
  out({
    ok: true,
    dryRun,
    handled: handled.map((h) => ({ repo: h.repo, number: h.number, state: h.state, routed: h.routed ?? null, message: h.message ?? null })),
    summary: summarize(handled),
  })
}

function summarize(handled) {
  const counts = {}
  for (const h of handled) counts[h.state] = (counts[h.state] ?? 0) + 1
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`)
  return parts.length ? parts.join("，") : "没有可接的工单"
}

async function cmdTasks(pos, flags) {
  const cfg = loadConfig(flags.config)
  const result = await sessionTasks(makeCtx(cfg))
  if (flags.json) return out(result)
  process.stdout.write(formatSessionTasks(result))
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

// mail：UI 验收邮件的发/收/判。testers 还是占位符时不发信、也不挡合并（沿用人工验收）。
async function cmdMail(pos, flags) {
  const cfg = loadConfig(flags.config)
  const sub = pos.shift() || "requests"
  const SUBS = ["request", "poll", "requests", "approve", "reject"]
  if (!SUBS.includes(sub)) throw new Error(`用法：foreman mail ${SUBS.join("|")} …`)
  const port = await resolvePort(cfg)

  if (sub === "request") {
    const key = String(pos[0] ?? "").trim()
    if (!key) throw new Error("mail request 要 <owner/repo>#<N>")
    const r = await callRaw(
      port,
      {
        id: "cli",
        cmd: "mail request",
        key,
        url: strFlag(flags.url),
        issueKey: strFlag(flags.issue),
        title: strFlag(flags.title),
      },
      300000
    )
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }

  if (sub === "poll") {
    const r = await callRaw(port, { id: "cli", cmd: "mail poll" }, 300000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }

  if (sub === "requests") {
    const r = await callRaw(port, { id: "cli", cmd: "mail requests" }, 60000)
    if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
    return out({ ok: true, ...r })
  }

  // approve / reject：人工记一次验收结论（测试同学当面/群里说的，也走这里）。
  const key = String(pos[0] ?? "").trim()
  if (!key) throw new Error(`mail ${sub} 要 <owner/repo>#<N>`)
  const r = await callRaw(
    port,
    {
      id: "cli",
      cmd: `mail ${sub}`,
      key,
      by: strFlag(flags.by),
      note: strFlag(flags.note),
    },
    60000
  )
  if (!r.ok) throw new Error(`${r.error}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdMemory(pos, flags) {
  const cfg = loadConfig(flags.config)
  const action = String(pos.shift() ?? "show")
  const store = new MemoryStore(cfg)
  if (action === "show") return out({ ok: true, ...store.show() })
  if (action === "dream") {
    const dws = makeSessionAdapter(cfg, {})
    return out(await dreamOnce({ cfg, dws }, { day: strFlag(flags.day), force: flags.force === true }))
  }
  if (action === "dream-status") return out(store.dreamStatus())
  if (action === "dream-report") {
    return out(store.dreamReport({ day: strFlag(flags.day), runId: strFlag(flags.run), text: strFlag(flags.text) }))
  }
  if (action === "set") {
    return out(store.set({ target: strFlag(flags.target), key: strFlag(flags.key), text: strFlag(flags.text) }))
  }
  if (action === "note") return out(store.note({ text: strFlag(flags.text) }))
  if (action === "forget") return out(store.forget({ target: strFlag(flags.target), key: strFlag(flags.key) }))
  if (action === "search") return out(store.search(pos.join(" "), { limit: Number(flags.limit ?? 8) }))
  throw new Error(`未知 memory 子命令：${action}（show|set|forget|note|search|dream|dream-status|dream-report）`)
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
  const { giteaHealth } = await import("../src/gitea.mjs")
  const giteaCheck = await giteaHealth()
  checks.push({ name: "gitea", ...giteaCheck })
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
      await ctx.dws.start()
      checks.push({ name: "dws 窗口/登录", ok: true, detail: "窗口可用，已登录" })
    } catch (e) {
      checks.push({ name: "dws 窗口/登录", ok: false, detail: e.message })
    }
  }

  // 邮件通道：开了才查（没授权时发信会失败，提前在这里暴露比等合并被卡好）。
  if (cfg.mail?.enabled === true) {
    try {
      const { MailDriver } = await import("../src/mail.mjs")
      const { realRecipients } = await import("../src/mail.mjs")
      const me = await new MailDriver({ bin: cfg.mail.bin }).me()
      checks.push({
        name: "邮件通道",
        ok: true,
        detail: `${me.email || "已授权"} · 验收人 ${realRecipients(cfg).join("、") || "未配置（占位符）"}`,
      })
    } catch (e) {
      checks.push({ name: "邮件通道", ok: false, detail: e.message })
    }
  } else {
    checks.push({ name: "邮件通道", ok: true, detail: "未启用（mail.enabled=false）" })
  }

  const ok = checks.every((c) => c.ok)
  out({ ok, checks, config: cfg.configPath || "（用默认值）" })
  if (!ok) process.exitCode = 1
}

async function cmdOrch(pos, flags) {
  const cfg = loadConfig(flags.config)
  const action = String(pos[0] ?? "show")
  if (action !== "show") throw new Error("用法：foreman orch show（orch start 已删除：接单自动按单建编排）")
  const port = await resolvePort(cfg)
  const r = await callRaw(port, { id: "cli", cmd: `orch ${action}`, name: flags.name && flags.name !== true ? String(flags.name) : "" }, 600000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}


// 调用方会话 = 谁发起的这张单。两种来源：
//   1) 路由智能体接单：服务进程没有用户会话 → hand 按工单建独立编排；手工兼容场景才用全局编排；
//   2) 用户在自己的豆包会话里发起：显式 --orchestrator <id|名称>，或自动取 MCP_VM_CONVERSATION_ID
//      （在会话里跑时它就是发起方那条会话）。--no-orchestrator 关掉自动识别。
function callerOrchestrator(flags = {}) {
  const explicit = String(flags.orchestrator ?? flags.orch ?? "").trim()
  if (explicit) return explicit
  if (truthy(flags["no-orchestrator"])) return ""
  return String(process.env.MCP_VM_CONVERSATION_ID ?? "").trim()
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

async function cmdRoute(pos, flags) {
  const cfg = loadConfig(flags.config)
  const port = await resolvePort(cfg)
  const r = await callRaw(port, { id: "cli", cmd: "route" }, 300000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdInbox(pos, flags) {
  const action = String(pos[0] ?? "list")
  if (action !== "list") throw new Error("用法：foreman inbox list [--limit <N>]")
  const cfg = loadConfig(flags.config)
  const r = await callRaw(await resolvePort(cfg), { id: "cli", cmd: "inbox list", limit: Number(flags.limit ?? 100) }, 60000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdSend(pos, flags) {
  const cfg = loadConfig(flags.config)
  const type = strFlag(flags.type).toLowerCase()
  if (!["mail", "lark"].includes(type)) throw new Error("用法：foreman send --type mail|lark …")
  const r = await callRaw(await resolvePort(cfg), {
    id: "cli", cmd: "send", type,
    to: strFlag(flags.to), subject: strFlag(flags.subject), body: strFlag(flags.body),
    sessionId: strFlag(flags["session-id"]) || String(process.env.MCP_VM_CONVERSATION_ID ?? "").trim(),
    chatId: strFlag(flags["chat-id"]), userId: strFlag(flags["user-id"]),
    text: strFlag(flags.text), markdown: strFlag(flags.markdown),
    dedupeKey: strFlag(flags["dedupe-key"]),
  }, 60000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdOutbox(pos, flags) {
  const action = String(pos[0] ?? "list")
  if (!["list", "run"].includes(action)) throw new Error("用法：foreman outbox list|run …")
  const cfg = loadConfig(flags.config)
  const r = await callRaw(await resolvePort(cfg), {
    id: "cli", cmd: `outbox ${action}`,
    limit: Number(flags.limit ?? 100), status: strFlag(flags.status), channel: strFlag(flags.channel),
  }, 300000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

async function cmdWorker(pos, flags) {
  const action = String(pos[0] ?? "run")
  if (action !== "run") throw new Error("用法：foreman worker run")
  const cfg = loadConfig(flags.config)
  const r = await callRaw(await resolvePort(cfg), { id: "cli", cmd: "worker run" }, 300000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}




async function cmdClean(pos, flags) {
  const cfg = loadConfig(flags.config)
  const ref = String(pos[0] ?? flags.issue ?? "").trim()
  const all = truthy(flags.all)
  if (!ref && !all) throw new Error("用法：foreman clean <owner/name>#<单号>（或 --all）")
  const port = await resolvePort(cfg)
  // 带上调用方会话 id：clean 会顺手归档这张单的编排会话，但要放过正在执行这条命令的那条。
  const r = await callRaw(port, { id: "cli", cmd: "clean", issue: ref, all, ...callerOrchestratorArg(flags) }, 900000)
  if (!r.ok) throw new Error(`${r.error ?? "error"}：${r.message ?? ""}`)
  return out({ ok: true, ...r })
}

// clean 只要 id、不打印「更新会 steer 到这里」那行提示，所以不复用 orchestratorArg。
function callerOrchestratorArg(flags = {}) {
  const who = callerOrchestrator(flags)
  return who ? { orchestrator: who } : {}
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
    case "route":
    case "router":
    case "inspect":
      return cmdRoute(pos, flags)
    case "inbox":
      return cmdInbox(pos, flags)
    case "send":
      return cmdSend(pos, flags)
    case "outbox":
      return cmdOutbox(pos, flags)
    case "worker":
      return cmdWorker(pos, flags)
    case "memory":
      return cmdMemory(pos, flags)
    case "clean":
      return cmdClean(pos, flags)
    case "pickup":
      return cmdPickup(pos, flags)
    case "tasks":
      return cmdTasks(pos, flags)
    case "retry":
      return cmdRetry(pos, flags)
    case "mail":
      return cmdMail(pos, flags)
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
