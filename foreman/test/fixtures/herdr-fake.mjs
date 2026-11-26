#!/usr/bin/env node
// 假 herdr CLI：模拟 herdr 0.9.5 的 agent/pane JSON 面，供 zcodedrv 的 herdr 驱动测试用。
// 状态存 HERDR_FAKE_STATE 指定的 JSON 文件；轮次时长 HERDR_FAKE_WORK_MS（默认 1200ms）；
// HERDR_FAKE_BLOCK=1 时轮次永远 blocked（测权限拦截）。
// 支持的子命令：--version / status server / workspace create|close / pane run|read|send-keys /
// report-agent / agent get|list。轮次完成靠 agent get 时按时间翻转 working→idle 并推 seq。
// waitFinished 的 status 轮询与驱动轮询会并发调 CLI：读改写必须拿锁串行，否则互相覆盖丢提交。
import fs from "node:fs"

const stateFile = process.env.HERDR_FAKE_STATE
if (!stateFile) {
  console.error("HERDR_FAKE_STATE not set")
  process.exit(2)
}
const WORK_MS = Number(process.env.HERDR_FAKE_WORK_MS ?? 1200)
const LOCK = `${stateFile}.lock`
const args = process.argv.slice(2)

function acquire() {
  const t0 = Date.now()
  while (Date.now() - t0 < 5000) {
    try {
      fs.mkdirSync(LOCK)
      return
    } catch (e) {
      if (e?.code !== "EEXIST") return
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 3000) fs.rmSync(LOCK, { recursive: true, force: true })
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
}

function release() {
  try {
    fs.rmSync(LOCK, { recursive: true, force: true })
  } catch {}
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"))
  } catch {
    return { seq: 0, panes: {} }
  }
}

function save(s) {
  const tmp = `${stateFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s))
  fs.renameSync(tmp, stateFile)
}

function out(obj) {
  console.log(JSON.stringify(obj))
}

// 轮次文本：普通 prompt 原样回显；「请先完整阅读文件 <path>」类 prompt 读文件内容一起回。
function replyFor(text) {
  const t = String(text ?? "")
  const m = /文件\s+(\S+)\s+中的全部指令/.exec(t)
  if (m) {
    let content = ""
    try {
      content = fs.readFileSync(m[1], "utf8").slice(0, 120)
    } catch {}
    return `reply(attach): ${content}`
  }
  return `reply(${t.slice(0, 60)})`
}

function completeIfDue(p, now = Date.now()) {
  if (p.status === "working" && p.workingSince && now - p.workingSince >= WORK_MS) {
    if (process.env.HERDR_FAKE_BLOCK === "1") return
    p.status = "idle"
    p.seq += 2
    p.replies.push(replyFor(p.prompts.at(-1) ?? ""))
  }
}

let exitCode = 0
acquire()
try {
  const state = load()
  const [cmd, ...rest] = args

  if (cmd === "--version" || cmd === "-V") {
    console.log("herdr 0.9.5")
  } else if (cmd === "status") {
    console.log("status: running\nversion: 0.9.5")
  } else if (cmd === "workspace" && rest[0] === "create") {
    state.seq += 1
    const pane = `ws${state.seq}:p1`
    state.panes[pane] = { launched: false, registered: false, status: "unknown", seq: 0, prompts: [], replies: [], screen: [] }
    save(state)
    out({ id: "cli:workspace:create", result: { workspace: { workspace_id: `ws${state.seq}`, label: "x" }, root_pane: { pane_id: pane, agent_status: "unknown" } } })
  } else if (cmd === "workspace" && rest[0] === "close") {
    const ws = rest[1]
    for (const p of Object.keys(state.panes)) {
      if (p.startsWith(`${ws}:`)) delete state.panes[p]
    }
    save(state)
    out({ id: "cli:workspace:close", result: { type: "ok" } })
  } else if (cmd === "pane" && rest[0] === "run") {
    const pane = rest[1]
    const text = rest.slice(2).join(" ")
    const p = state.panes[pane]
    if (!p) {
      out({ error: { code: "pane_not_found", message: "no such pane" } })
    } else if (!p.launched) {
      // 第一次 pane run 是启动 runtime：记下启动命令行（测 --mode 拼装），摆 TUI 就绪画面
      p.launched = true
      p.launchCmd = text
      p.screen.push("Ask a task about this workspace", "◈ fake/glm ─ ◉ build ─ ctx 100%")
      save(state)
      out({ id: "cli:pane:run", result: { type: "ok" } })
    } else {
      p.prompts.push(text)
      // HERDR_FAKE_BLOCK=1 模拟权限对话框卡住，测 agent_blocked 路径
      p.status = process.env.HERDR_FAKE_BLOCK === "1" ? "blocked" : "working"
      p.workingSince = Date.now()
      p.seq += 1
      save(state)
      out({ id: "cli:pane:run", result: { type: "ok" } })
    }
  } else if (cmd === "pane" && rest[0] === "read") {
    const p = state.panes[rest[1]]
    if (!p) {
      console.error("no such pane")
      exitCode = 1
    } else {
      const lines = p.launched ? [...p.screen] : ["(shell)"]
      for (let i = 0; i < p.prompts.length; i++) {
        lines.push(`› ${p.prompts[i].slice(0, 40)}`)
        if (p.replies[i]) lines.push(p.replies[i])
      }
      console.log(lines.slice(-Number(rest.at(-1) ?? 12)).join("\n"))
    }
  } else if (cmd === "pane" && rest[0] === "send-keys") {
    const p = state.panes[rest[1]]
    if (p && rest[2] === "escape" && p.status === "working") {
      p.status = "idle"
      p.seq += 1
      p.stopped = true
      save(state)
    }
  } else if (cmd === "pane" && rest[0] === "report-agent") {
    const p = state.panes[rest[1]]
    if (p) {
      if (!p.agent) p.seq += 1
      p.agent = "zcode"
      p.registered = true
      const sidIdx = rest.indexOf("--agent-session-id")
      if (sidIdx > 0) p.sessionId = rest[sidIdx + 1]
      save(state)
    }
    out({ id: "cli:pane:report-agent", result: { type: "ok" } })
  } else if (cmd === "agent" && rest[0] === "get") {
    const p = state.panes[rest[1]]
    if (!p || !p.registered) {
      out({ error: { code: "agent_not_found", message: "agent target not found" } })
    } else {
      completeIfDue(p)
      save(state)
      out({ id: "cli:agent:get", result: { agent: { pane_id: rest[1], agent: "zcode", agent_status: p.status, state_change_seq: p.seq, cwd: "/tmp/repo-a" } } })
    }
  } else if (cmd === "agent" && rest[0] === "list") {
    const agents = []
    for (const [pane, p] of Object.entries(state.panes)) {
      if (p.registered) {
        completeIfDue(p)
        agents.push({ pane_id: pane, agent: "zcode", agent_status: p.status })
      }
    }
    save(state)
    out({ id: "cli:agent:list", result: { agents } })
  } else {
    console.error(`herdr-fake: unknown args ${JSON.stringify(args)}`)
    exitCode = 2
  }
} finally {
  release()
}
process.exit(exitCode)
