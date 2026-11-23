import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { startServer } from "../src/service.mjs"

const BIN = fileURLToPath(new URL("../bin/foreman.mjs", import.meta.url))

function fixture({ failDws = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-dreaming-"))
  const config = path.join(dir, "foreman.json")
  const capture = path.join(dir, "prompt.md")
  const fakeDws = path.join(dir, "fake-dws.mjs")
  fs.writeFileSync(fakeDws, `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
if (${JSON.stringify(failDws)}) {
  console.error("mock dws failed")
  process.exit(1)
}
const file = args[args.indexOf("--file") + 1]
fs.writeFileSync(${JSON.stringify(capture)}, fs.readFileSync(file, "utf8"))
console.log(JSON.stringify({ ok: true, convId: "dream-session" }))
`, { mode: 0o755 })
  fs.writeFileSync(config, JSON.stringify({
    service: { enabled: false },
    agent: "dws",
    memory: { dir: "memory" },
    dws: { bin: fakeDws },
  }))
  return { dir, config, capture }
}

function memory(f, args, { ok = true } = {}) {
  const result = spawnSync(process.execPath, [BIN, "memory", ...args, "--config", f.config, "--no-service"], {
    encoding: "utf8",
  })
  if (ok) {
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.notEqual(result.status, 0, result.stdout)
  return result.stderr
}

test("空日记不创建 Agent，投递失败记录 failed 且允许重试", () => {
  const empty = fixture()
  try {
    const result = memory(empty, ["dream", "--day", "2026-11-18"])
    assert.equal(result.skipped, "no-daily-memory")
    assert.equal(fs.existsSync(empty.capture), false)
    assert.deepEqual(memory(empty, ["dream-status"]).days, {})
  } finally {
    fs.rmSync(empty.dir, { recursive: true, force: true })
  }

  const failed = fixture({ failDws: true })
  try {
    const memoryDir = path.join(failed.dir, "memory")
    fs.mkdirSync(path.join(memoryDir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, "memory", "2026-11-18.md"), "一条持久偏好证据。\n")
    assert.match(memory(failed, ["dream", "--day", "2026-11-18"], { ok: false }), /dws open/)
    assert.equal(memory(failed, ["dream-status"]).days["2026-11-18"].status, "failed")
    assert.match(memory(failed, ["dream", "--day", "2026-11-18"], { ok: false }), /dws open/)
  } finally {
    fs.rmSync(failed.dir, { recursive: true, force: true })
  }
})

test("构造 dreaming 提示词失败时记录 failed，不停留在 running", () => {
  const f = fixture()
  try {
    const memoryDir = path.join(f.dir, "memory")
    fs.mkdirSync(path.join(memoryDir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, "memory", "2026-11-18.md"), "一条持久偏好证据。\n")
    fs.mkdirSync(path.join(memoryDir, "MEMORY.md"))
    assert.match(memory(f, ["dream", "--day", "2026-11-18"], { ok: false }), /EISDIR|illegal operation on a directory/)
    assert.equal(memory(f, ["dream-status"]).days["2026-11-18"].status, "failed")
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("dream-report 留下可审阅日记并完成状态，重复整理需显式 force", () => {
  const f = fixture()
  try {
    const memoryDir = path.join(f.dir, "memory")
    fs.mkdirSync(path.join(memoryDir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, "memory", "2026-11-18.md"), "用户要求回复使用简体中文。\n")
    const first = memory(f, ["dream", "--day", "2026-11-18"])
    assert.equal(memory(f, ["dream", "--day", "2026-11-18"]).skipped, "already-running")

    const report = memory(f, [
      "dream-report", "--day", "2026-11-18", "--run", first.runId,
      "--text", "Light：1 条信号；REM：回复语言；Deep：提升 1 条用户偏好。",
    ])
    assert.equal(report.status, "completed")
    const status = memory(f, ["dream-status"])
    assert.equal(status.days["2026-11-18"].status, "completed")
    memory(f, [
      "dream-report", "--day", "2026-11-18", "--run", first.runId,
      "--text", "Light：1 条信号；REM：回复语言；Deep：提升 1 条用户偏好。",
    ])
    const diary = fs.readFileSync(path.join(memoryDir, "DREAMS.md"), "utf8")
    assert.match(diary, /Light：1 条信号/)
    assert.equal(diary.split(`<!-- dream-run:${first.runId} -->`).length - 1, 1)
    assert.equal(memory(f, ["search", "Light：1 条信号"]).results.length, 0, "Dream Diary 不得成为提升证据")
    assert.equal(memory(f, ["dream", "--day", "2026-11-18"]).skipped, "already-completed")

    const forced = memory(f, ["dream", "--day", "2026-11-18", "--force"])
    assert.equal(forced.dispatched, true)
    assert.notEqual(forced.runId, first.runId)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("dream 把单日日记交给独立 Agent，三阶段整理但不直接改核心文件", () => {
  const f = fixture()
  try {
    const memoryDir = path.join(f.dir, "memory")
    fs.mkdirSync(path.join(memoryDir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, "memory", "2026-11-18.md"), "## 2026-11-18T10:00:00.000Z\n\n用户两次要求回复使用简体中文。\n")

    const result = memory(f, ["dream", "--day", "2026-11-18"])
    assert.equal(result.ok, true)
    assert.equal(result.day, "2026-11-18")
    assert.equal(result.dispatched, true)
    assert.ok(result.runId)
    assert.equal(memory(f, ["show"]).memory.entries, 0)

    const prompt = fs.readFileSync(f.capture, "utf8")
    assert.match(prompt, /Light/)
    assert.match(prompt, /REM/)
    assert.match(prompt, /Deep/)
    assert.match(prompt, /用户两次要求回复使用简体中文/)
    assert.match(prompt, /memory-dreaming-2026-11-18/)
    assert.match(prompt, new RegExp(`dream-report --day 2026-11-18 --run ${result.runId}`))
    assert.match(prompt, /禁止直接写入、编辑或覆盖 MEMORY\.md \/ USER\.md/)
    assert.match(prompt, /不会自动精简、截断或合并/)
    assert.match(prompt, new RegExp(f.config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("服务 Schedule 注册每日 03:00 dreaming，并能手动整理前一日", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-dreaming-schedule-"))
  const pad = (value) => String(value).padStart(2, "0")
  const now = new Date()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const day = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`
  const memoryDir = path.join(dir, "memory")
  fs.mkdirSync(path.join(memoryDir, "memory"), { recursive: true })
  fs.writeFileSync(path.join(memoryDir, "memory", `${day}.md`), "稳定偏好：始终先给结论。\n")
  const opened = []
  const dws = {
    async openNew(args) {
      opened.push(args)
      return { ok: true, convId: "dream-schedule" }
    },
    async queue() { return { ok: true } },
  }
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    agent: "dws",
    memory: { dir: memoryDir, dreaming: { enabled: true, cron: "0 3 * * *" } },
    router: { enabled: false },
    prWatch: { enabled: false },
    mail: { enabled: false },
    workHours: { enabled: false },
    pickup: { maxRunning: 2 },
    inbox: { schedulePollMs: 60000, pollMs: 60000 },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    repos: [],
  }
  let server
  try {
    server = await startServer({ cfg, dws, log() {} })
    const schedule = server.inbox.schedules().find((item) => item.id === "dreaming")
    assert.equal(schedule.enabled, true)
    assert.equal(schedule.cron, "0 3 * * *")
    const result = await server.schedules.runNow("dreaming")
    assert.equal(result.result.ok, true)
    assert.equal(opened.length, 1)
    assert.match(opened[0].prompt, /稳定偏好：始终先给结论/)
    assert.match(opened[0].prompt, new RegExp(day))
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
