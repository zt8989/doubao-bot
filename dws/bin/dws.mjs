#!/usr/bin/env node
// dws —— 豆包（工作）会话 CLI
// 开会话 / 发指令 / 看会话状态 / 取会话信息。只管豆包，不接单、不碰 PR。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, ConfigError } from "../src/config.mjs"
import { SessionBook, SessionManager, transcript, matchTask } from "../src/sessions.mjs"
import { Doubao } from "../src/doubao.mjs"
import { isTruthy, log, parseArgs, printJson, selfConvIds } from "../src/util.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version

const HELP = `dws ${VERSION} —— 豆包会话 CLI（开启会话 / 会话状态 / 会话信息）

用法：
  dws open  --name <会话名> [--repo <owner/name>] [--project <项目名>] [--prompt <文字> | --file <文件>]
            [--mode local|cloud] [--model auto|<模型 id>] [--no-wait]
  dws projects                      列出豆包侧边栏「项目」分组下的项目
  dws list                          列出豆包窗口里的全部工作任务 + 本地记录的会话
  dws use  <任务id|会话名>           把豆包窗口切到那条任务
  dws archive <任务id|会话名>        整段对话存到本地 archives/ 并把豆包侧边栏里的任务归档收起
  dws stop  <任务id|会话名>          中断正在跑的任务（双击 Esc；没在跑会如实说）
  dws steer <任务id|会话名> <文字>   跑动中追加指令（Command+Enter，不打断当前任务）
  dws status [会话名|任务id] [--json]       看会话状态（是否还在跑 / 是否已跑完）
  dws info  [会话名|任务id] [--json] [--out <文件>]   取会话信息（整段对话）
  dws send  <会话名|任务id> <文字> | --file <文件>     在同一任务里续说；任务不在了就重开并带 handoff
  dws doctor [--start]               自检：豆包二进制、profile、配置、登录态
  dws help <命令>                   看某条命令的用法（等价于 dws <命令> --help）

公共参数：
  -c, --config <文件>   配置文件（默认 ./config.json，其次 ~/.dws/config.json）

会话名可以是本地记录的名字，也可以是豆包侧边栏里的任务标题：按标题精确匹配，
其次唯一包含匹配；命中后命令输出里会写明实际操作的「任务 <id>」，多条重名则不猜、直接报错。

自我保护：dws archive / dws stop 会拒绝操作「发出这条命令的会话自己」
（从 MCP_VM_CONVERSATION_ID 等环境变量认出来），避免把自己归档或中断掉；确实要动就加 --force。

边界：
  dws 只负责驱动豆包桌面端（开会话、发指令、读状态）。它不碰工单、不碰 PR、
  不碰 git 远端；这些由别的工具做。
`

// `-c <文件>` 与 `--config <文件>` 等价：parseArgs 只认 `--key value`，
// 单横线参数一律当布尔，`-c x.json` 会把值漏成位置参数。
const argv = process.argv.slice(2).map((a) => (a === "-c" ? "--config" : a))
const cmd = argv[0]
const { pos, flags } = parseArgs(argv.slice(1))

// 每条命令的用法。子命令的 --help/-h 只打印这里的内容，绝不进入执行流程
// （历史上子命令的 --help 曾被当成真实执行，所以这里独立于执行流程）。
const HELP_BY_CMD = {
  open: [
    "dws open --name <会话名> [--repo <owner/name>] [--project <项目名>] [--prompt <文字> | --file <文件>]\n            [--mode local|cloud] [--model auto|<模型 id>] [--no-wait]",
    "新建一条工作任务（会话）。带 --prompt/--file 会顺带把第一句发出去并等它跑完；不带就只建任务。豆包是单实例，先 ⌘Q 退出自己的豆包。",
    "--no-wait 只确认首句送达并回读新会话 id，不等第一轮回复（每次新建会话的通知用）。",
  ],
  projects: ["dws projects", "列出豆包侧边栏「项目」分组下的项目。"],
  list: ["dws list", "列出豆包窗口里的全部工作任务 + 本地记录的会话。"],
  use: ["dws use <任务id|会话名>", "把豆包窗口切到那条任务。会切走用户当前的窗口，用户正在用时不要调。"],
  archive: [
    "dws archive <任务id|会话名> [--force]",
    "整段对话存到本地 archives/，并把豆包侧边栏里的任务归档收起。目标是发出命令的会话自己时会被拒绝（防止把自己归档掉），确认要这么做加 --force。",
  ],
  stop: [
    "dws stop <任务id|会话名> [--force]",
    "中断正在跑的任务（双击 Esc）；没在跑会如实说。目标是发出命令的会话自己时会被拒绝，确认要这么做加 --force。",
  ],
  steer: [
    "dws steer <任务id|会话名> <文字>",
    "跑动中追加指令（Command+Enter），不打断当前任务。",
  ],
  status: [
    "dws status [会话名|任务id] [--json]",
    "看会话状态（是否还在跑 / 是否已跑完）。需要连上豆包窗口；窗口里是别的任务时会报“不在当前窗口里”并给落盘摘要。",
  ],
  info: [
    "dws info [会话名|任务id] [--json] [--out <文件>]",
    "取整段对话（含思考）。对话很长，建议 --out 落盘再读。",
  ],
  send: [
    "dws send <会话名|任务id> <文字> | --file <文件> [--no-wait]",
    "在同一任务里续说；任务已不在窗口时会新开一条并带 handoff（进展都在工作区提交里）。",
    "--no-wait 只确认送达、不等回复（通知这类场景用；目标在跑时用 Command+Enter 追加，不打断）。",
  ],
  doctor: [
    "dws doctor [--start]",
    "自检：豆包二进制、profile、配置。--start 会真的拉起豆包查登录态。",
  ],
}

const CANONICAL_CMD = { continue: "send", say: "send" }

function commandHelp(name) {
  const key = CANONICAL_CMD[name] ?? name
  const entry = HELP_BY_CMD[key]
  if (!entry) return `未知命令：${name}\n\n${HELP}`
  const [usage, note] = entry
  return `用法：\n  ${usage}\n\n${note}\n\n公共参数：\n  -c, --config <文件>   配置文件（默认 ./config.json，其次 ~/.dws/config.json）\n\n全部命令：dws --help`
}

// 本轮命令用到的会话；WebSocket 不关进程不退出，main 结束时统一关。
let liveSession = null
if (flags.config) flags.c = flags.config
if (flags.c) flags.config = flags.c

main()
  .catch((e) => {
    if (e instanceof ConfigError) {
      log(`配置有问题：${e.message}`)
      process.exit(1)
    }
    log(`✗ ${e.message}`)
    if (flags.verbose && e.stack) log(e.stack)
    process.exit(1)
  })
  .finally(() => {
    liveSession?.close()
  })

async function main() {
  // 子命令的 --help/-h 只打帮助，绝不执行：`dws run --help` 曾真的开跑一轮。
  // 帮助优先于其它参数，`dws open --name x --help` 也只打帮助。
  if (flags.help || flags.h) return say(cmd && cmd !== "help" ? commandHelp(cmd) : HELP)
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      return say(pos[0] ? commandHelp(pos[0]) : HELP)
    case "-v":
    case "--version":
    case "version":
      return say(VERSION)
    case "open":
      return cmdOpen()
    case "list":
      return cmdList()
    case "use":
      return cmdUse()
    case "projects":
      return cmdProjects()
    case "archive":
      return cmdArchive()
    case "stop":
      return cmdStop()
    case "steer":
      return cmdSteer()
    case "status":
      return cmdStatus()
    case "info":
      return cmdInfo()
    case "send":
    case "continue":
    case "say":
      return cmdSend()
    case "doctor":
      return cmdDoctor()
    default:
      return say(`未知命令：${cmd}\n\n${HELP}`)
  }
}

function say(text) {
  process.stdout.write(text.replace(/\s+$/, "") + "\n")
}

// optionalCtx：会话类命令不强依赖配置；没有配置就用默认 state 文件。
function ctx({ needConfig = false } = {}) {
  let cfg = null
  try {
    cfg = loadConfig(flags.config)
  } catch (e) {
    if (needConfig || !(e instanceof ConfigError)) throw e
  }
  const stateFile = cfg?.stateFile ?? path.resolve(process.cwd(), ".dws/state.json")
  const book = new SessionBook(stateFile)
  const doubao = new Doubao({
    idleMs: (cfg?.idleMinutes ?? 6) * 60000,
    totalMs: (cfg?.timeoutMinutes ?? 45) * 60000,
    poll: (cfg?.pollSeconds ?? 4) * 1000,
  })
  const session = new SessionManager({ book, doubao, mode: cfg?.mode ?? "local", model: cfg?.model ?? "auto" })
  liveSession = session
  return { cfg, book, session, doubao }
}

async function cmdOpen() {
  const name = String(flags.name ?? flags.n ?? "").trim()
  if (!name) throw Error("要一个会话名：dws open --name win-ai-harness")
  const { book, session } = ctx()
  const prompt = await promptOf()
  const repo = flags.repo && flags.repo !== true ? String(flags.repo) : ""
  const mode = flags.mode && flags.mode !== true ? String(flags.mode) : undefined
  const model = flags.model && flags.model !== true ? String(flags.model) : undefined
  const project = flags.project && flags.project !== true ? String(flags.project) : ""
  const noWait = isTruthy(flags["no-wait"], false)
  log(`开会话 ${name}${repo ? `（${repo}）` : ""}${project ? `（项目 ${project}）` : ""}……（豆包窗口会被切到新任务）`)
  const opened = await session.open(name, { prompt, repo, mode, model, project, noWait })
  const out = {
    ok: true,
    session: opened.session?.name,
    convId: opened.session?.convId,
    mode: opened.session?.mode,
    model: opened.session?.model,
    noWait: noWait || undefined,
    replied: !!opened.reply,
    reply: opened.reply
      ? {
          finished: !!opened.reply.finished,
          chars: (opened.reply.text ?? "").length,
          status: opened.reply.status,
          reason: opened.reply.reason,
        }
      : null,
  }
  printJson(out)
}

// 任务 id：豆包会话 id 是 8 位以上纯数字，也接受 /chat/<id> 形式。
function isTaskId(s) {
  return /^(\/?(chat\/)?)(\d{8,})$/.test(String(s).trim())
}
function taskIdOf(s) {
  return String(s).trim().match(/(\d{8,})$/)[1]
}

// 目标解析：任务 id 直接用；会话名先查本地记录，再按标题匹配豆包侧边栏任务。
// 返回 { id, name, title, from }，from = "id" | "local" | "window"。
async function resolveTarget({ book, session }, target) {
  if (isTaskId(target)) return { id: taskIdOf(target), name: "", title: "", from: "id" }
  const local = book.session(target)
  if (local?.convId) return { id: local.convId, name: target, title: local.title || target, from: "local" }
  const hit = matchTask(await session.windowTasks().catch(() => []), target)
  if (hit) return { id: String(hit.id), name: target, title: hit.title || target, from: "window" }
  throw Error(`不是任务 id，也没找到这个会话：${target}（先 dws list 看看有什么）`)
}

// 找到 id 时顺手把来源说清楚，免得用户不知道自己刚动的是哪条任务。
function whereFrom(r) {
  if (r.from === "window") return `（按标题「${r.title}」在窗口中匹配到）`
  if (r.from === "local") return `（本地会话 ${r.name}）`
  return ""
}

// 发出命令的这一侧自己是谁：豆包 side 里跑命令时环境变量带着当前会话 id，
// 用来挡住「把自己归档/中断」这种误伤。终端里手跑时通常没有，只能靠人工判断。
function guardSelf(tgt, action) {
  if (flags.force) return
  if (!selfConvIds().includes(tgt.id)) return
  throw Error(
    `拒绝${action}：任务 ${tgt.id}${tgt.title ? `「${tgt.title}」` : ""} 就是发出这条命令的会话自己。` +
      `对它动手会把你正在用的窗口和上下文一起收掉；确认要这么做就加 --force。`
  )
}

async function cmdProjects() {
  const { session } = ctx()
  const projects = (await session.windowProjects()) ?? []
  const tasks = (await session.windowTasks().catch(() => [])) ?? []
  if (flags.json) return printJson({ ok: true, projects, tasksByProject: tasks })
  if (!projects.length) {
    say(`豆包侧边栏还没有项目（在豆包里「项目」分组旁的「新建项目」先建一个）`)
    return
  }
  const lines = [`豆包项目（${projects.length} 个）：`]
  for (const p of projects) {
    const inProj = tasks.filter((t) => t.project === p)
    const marks = inProj.filter((t) => t.running).length
    lines.push(`  ${p}　${inProj.length} 条任务${marks ? `（${marks} 条在跑）` : ""}`)
  }
  lines.push(`  在项目下开会话：dws open --name <会话名> --project ${projects[0]}`)
  say(lines.join("\n"))
}

async function cmdList() {
  const { book, session } = ctx()
  let tasks = null
  let taskErr = ""
  try {
    tasks = await session.windowTasks()
  } catch (e) {
    taskErr = e.message.split("\n")[0]
  }
  const sessions = book.names().map((n) => {
    const s = book.session(n)
    return {
      name: n,
      repo: s.repo ?? "",
      convId: s.convId ?? "",
      mode: s.mode ?? "",
      openedAt: s.openedAt ?? "",
      updatedAt: s.updatedAt ?? "",
      lastReply: s.reply ? `${s.reply.finished ? "已完成" : "未完成"} ${s.reply.chars} 字` : "（还没有回复）",
    }
  })
  if (flags.json) return printJson({ ok: true, tasks: tasks ?? [], taskError: taskErr, sessions })
  const lines = []
  if (tasks) {
    lines.push(`豆包窗口里的工作任务（${tasks.length} 条）：`)
    for (const t of tasks) {
      const marks = [t.active ? "← 当前" : "", t.running ? "还在跑" : "", t.pending, t.unread ? `未读 ${t.unread}` : ""]
        .filter(Boolean)
        .join(" / ")
      lines.push(`  ${t.id}  ${t.title || "（无标题）"}${t.project ? `　[${t.project}]` : ""}${marks ? "　" + marks : ""}`)
    }
    lines.push(`  操作：dws use <任务id> 切换；dws info <任务id> 看内容；dws send <任务id> "<文字>" 续说`)
  } else {
    lines.push(`豆包窗口连不上（${taskErr}），只列本地记录：`)
  }
  if (sessions.length) {
    lines.push(``, `本地记录的会话：`)
    for (const r of sessions) {
      const s = book.session(r.name)
      const mark = s?.archived ? "　[已归档]" : ""
      lines.push(`  ${r.name}\t${r.repo}\t任务 ${r.convId || "-"}\t${r.lastReply}${mark}\t${r.updatedAt}`)
    }
  } else {
    lines.push(``, `本地记录：还没有会话（dws open --name <会话名> 开一条）`)
  }
  say(lines.join("\n"))
}

async function cmdUse() {
  const target = pos[0]
  if (!target) throw Error("用法：dws use <任务id|会话名>")
  const { book, session } = ctx()
  const r = await resolveTarget({ book, session }, target)
  log(`切到任务 ${r.id}${whereFrom(r)}……`)
  await session.use(r.id, { name: r.from === "local" ? r.name : "" })
  const s = await session.convStatus(r.id)
  say(
    [
        `已切到任务 ${r.id}${r.title ? `「${r.title}」` : ""}：${s.streaming ? "还在生成" : s.finished ? "已跑完" : "还没开始"}`,
      `  最近回复 ${s.chars} 字${s.head ? `：${s.head.slice(0, 80)}` : ""}`,
      `  看内容：dws info ${r.id}`,
    ].join("\n")
  )
}

async function cmdArchive() {
  const target = pos[0]
  if (!target) throw Error("用法：dws archive <任务id|会话名>")
  const { cfg, book, session } = ctx()
  const tgt = await resolveTarget({ book, session }, target)
  guardSelf(tgt, "归档")
  const dir = path.join(path.dirname(cfg?.stateFile ?? ".dws/state.json"), "archives")
  log(`归档任务 ${tgt.id}${whereFrom(tgt)}……`)
  const r = await session.archive(tgt.id, { name: tgt.from === "local" ? tgt.name : "", dir })
  say(
    [
      r.file ? `对话已存档：${r.file}（${r.messages} 条消息）` : `对话未落盘`,
      `豆包窗口里的任务 ${tgt.id} 已归档收起`,
      r.title ? `标题：${r.title}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  )
}

async function cmdStop() {
  const target = pos[0]
  if (!target) throw Error("用法：dws stop <任务id|会话名>")
  const { book, session } = ctx()
  const tgt = await resolveTarget({ book, session }, target)
  guardSelf(tgt, "中断")
  log(`停止任务 ${tgt.id}${whereFrom(tgt)}……`)
  const r = await session.stop(tgt.id, { name: tgt.from === "local" ? tgt.name : "" })
  say(r.stopped ? `任务 ${tgt.id} 已中断（点了「结束任务」）` : `任务 ${tgt.id} 没在跑，无需停止`)
}

async function cmdSteer() {
  const target = pos[0]
  if (!target) throw Error("用法：dws steer <任务id|会话名> <文字>（或 --file）")
  const { book, session } = ctx()
  const text = (await promptOf()) || pos.slice(1).join(" ")
  if (!text) throw Error("要追加的内容为空")
  const tgt = await resolveTarget({ book, session }, target)
  log(`向任务 ${tgt.id}${whereFrom(tgt)} 追加指令（Command+Enter，不打断当前任务）……`)
  const r = await session.convSteer(tgt.id, text)
  printJson({ ok: true, convId: tgt.id, title: tgt.title || undefined, sends: r.sends, note: "已追加，任务继续跑" })
}

async function cmdStatus() {
  const { book, session } = ctx()
  const target = pos[0]
  if (target) {
    const tgt = await resolveTarget({ book, session }, target)
    const s = await session.convStatus(tgt.id)
    if (flags.json) {
      return printJson({ ok: true, status: { ...s, name: tgt.name || tgt.id, convId: tgt.id, title: tgt.title || "" } })
    }
    say(
      [
        `任务 ${tgt.id}${tgt.title && tgt.from !== "local" ? `「${tgt.title}」` : ""}：${
          s.streaming ? "正在生成" : s.finished ? "已跑完" : "还没开始"
        }`,
        `  回复长度 ${s.chars} 字${s.error ? `，错误：${s.error}` : ""}${s.status ? `，状态 ${s.status}` : ""}`,
        s.head ? `  最近回复：${s.head.slice(0, 100)}` : "",
        `  看内容：dws info ${tgt.id}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    return
  }
  const names = book.names().length ? book.names() : []
  if (!names.length) {
    say(`本地还没有会话记录。窗口里的任务用 dws list 看（按任务 id 查：dws status <任务id>）。`)
    return
  }
  const results = []
  for (const name of names) {
    const s = await session.status(name)
    if (!s) {
      results.push({ name, unknown: true, error: "本地没有这个会话；窗口里的任务用 dws list 查，按 id 查用 dws status <任务id>" })
      continue
    }
    results.push(s)
  }
  if (flags.json || results.length > 1) {
    printJson({ ok: true, status: results })
    return
  }
  const s = results[0]
  if (s.unknown) {
    say(`${s.name}：${s.error}`)
    return
  }
  if (!s.live) {
    say(
      [
        `${s.session.name}：不在当前窗口里（${whyText(s.why)}）`,
        `  任务 ${s.session.convId || "-"}，最后更新 ${s.session.updatedAt}`,
        s.session.reply ? `  最后一次回复：${s.session.reply.chars} 字，${s.session.reply.head || ""}` : "",
        `  续会话：dws send ${s.session.name} "继续"`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    return
  }
  const r = s.reply
  say(
    [
      `${s.session.name}（任务 ${r.convId}）：${r.streaming ? "正在生成" : r.finished ? "已跑完" : "还没开始"}`,
      `  回复长度 ${r.chars} 字${r.error ? `，错误：${r.error}` : ""}${r.status ? `，状态 ${r.status}` : ""}`,
      `  看内容：dws info ${s.session.name}`,
    ].join("\n")
  )
}

async function cmdInfo() {
  const { book, session } = ctx()
  const target = pos[0] ?? book.names()[0]
  if (!target) {
    say(`本地还没有会话记录；窗口里的任务用 dws list 查，按 id 看用 dws info <任务id>。`)
    return
  }
  const tgt = await resolveTarget({ book, session }, target)
  const info = await session.convInfo(tgt.id)
  const label =
    tgt.from === "local" ? `${tgt.name} · 任务 ${tgt.id}` : `任务 ${tgt.id}${tgt.title ? `「${tgt.title}」` : ""}`
  if (flags.json) {
    if (flags.out) {
      fs.writeFileSync(String(flags.out), JSON.stringify(info, null, 2) + "\n")
      return say(`已写入 ${flags.out}`)
    }
    return printJson(info)
  }
  if (!info.live) {
    return say(`${label}：不在当前窗口里（${whyText(info.why)}），只能看到落盘的摘要：\n${JSON.stringify(info.session?.reply ?? {}, null, 2)}`)
  }
  const text = transcript(info)
  if (flags.out) {
    fs.writeFileSync(String(flags.out), text + "\n")
    return say(`已写入 ${flags.out}（${info.messages.length} 条消息）`)
  }
  say(`# ${label} · ${info.messages.length} 条消息\n\n${text}`)
}

async function cmdSend() {
  const target = pos[0]
  if (!target) throw Error("用法：dws send <会话名|任务id> <文字>（或 --file）")
  const { book, session } = ctx()
  const text = (await promptOf()) || pos.slice(1).join(" ")
  if (!text) throw Error("要发的内容为空")

  const tgt = await resolveTarget({ book, session }, target)

  if (tgt.from === "local") {
    const handoff = isTruthy(flags.handoff, true)
      ? `（接续 dws 会话 ${tgt.name}：进展都在工作区的提交里，先 git log / git status 看一眼再动手。）`
      : ""
    log(`续会话 ${tgt.name}（任务 ${tgt.id}）……`)
    const r = await session.send(tgt.name, text, { handoff })
    printJson({
      ok: true,
      session: tgt.name,
      reattached: r.reattached,
      convId: r.reply?.convId ?? tgt.id,
      finished: !!r.reply?.finished,
      chars: (r.reply?.text ?? "").length,
    })
    return
  }

  log(`续任务 ${tgt.id}${whereFrom(tgt)}……`)
  if (flags["no-wait"]) {
    // 只确认送达，不等回复：通知这类场景用，别让对面把这边拖到超时。
    const r = await session.convSendAck(tgt.id, text)
    printJson({ ok: true, convId: r.convId, sent: !!r.sent, noWait: true })
    return
  }
  const r = await session.convSend(tgt.id, text)
  printJson({
    ok: true,
    convId: r.convId,
    title: tgt.title || undefined,
    finished: !!r.reply?.finished,
    chars: (r.reply?.text ?? "").length,
  })
}

async function cmdDoctor() {
  const checks = []
  const add = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail })
  add("node", Number(process.versions.node.split(".")[0]) >= 22, process.versions.node)

  let cfg = null
  try {
    cfg = loadConfig(flags.config)
    add("config", true, cfg.path)
  } catch (e) {
    add("config", false, e.message)
  }

  const d = new Doubao()
  add("豆包二进制", fs.existsSync(d.app.binary), d.app.binary)
  add("豆包 profile", fs.existsSync(path.join(d.app.dataDir, "profile")), d.app.dataDir)
  if (isTruthy(flags.start, false)) {
    try {
      const st = await d.state()
      add("豆包登录态", st.signedIn, `${st.name || "?"} · ${st.url}`)
      d.close()
    } catch (e) {
      add("豆包窗口", false, `${e.code ?? ""} ${e.message}`)
    }
  } else {
    add("豆包窗口", true, "跳过（加 --start 会真的拉起窗口检查登录态）")
  }

  for (const c of checks) log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? "  " + c.detail : ""}`)
  const bad = checks.filter((c) => !c.ok)
  printJson({ ok: bad.length === 0, checks })
  process.exitCode = bad.length ? 1 : 0
}

async function promptOf() {
  if (flags.file) {
    const p = path.resolve(String(flags.file))
    return fs.readFileSync(p, "utf8")
  }
  if (typeof flags.prompt === "string" && flags.prompt !== "true") return flags.prompt
  return ""
}

function whyText(why) {
  return (
    {
      app_busy: "豆包正被你自己的窗口占着，先退掉再跑",
      app_missing: "没装豆包",
      signed_out: "豆包没登录",
      no_task: "窗口里还没有任务",
      other_task: "窗口里是另一个任务",
      app_error: "没连上豆包窗口",
    }[why] ?? why ?? "不在"
  )
}
