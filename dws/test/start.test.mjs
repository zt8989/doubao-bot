// dws start 的独占启动语义：端口在答就复用；豆包在跑但没开 CDP 时报 app_busy 并提示 --force；
// 带 --force 才杀进程，杀完再起。这里不碰真豆包：procs/kill/probe 全部注入。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { App } from "../src/cdp.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(ROOT, "bin", "dws.mjs")

const BIN = "/Applications/Doubao.app/Contents/MacOS/Doubao"
const CHAT = [{ type: "page", url: "doubao://doubao-chat/chat/123" }]

function mkApp({ procs = [], probe = async () => null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dws-start-"))
  const state = { procs: [...procs], killed: [], launched: 0 }
  const app = new App({
    binary: BIN,
    dataDir: dir,
    owns: () => true,
    probe,
    procs: () => state.procs,
    kill: async (pids) => {
      state.killed.push(...pids)
      state.procs = state.procs.filter((p) => !pids.includes(p.pid))
      return { term: pids, kill: [], stillAlive: [] }
    },
  })
  // 不真拉起豆包：只记一次调用并回一个端口
  app.launch = async () => {
    state.launched++
    return 4400
  }
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
  return { app, state, dir, cleanup }
}

test("端口在答就复用，不重启也不杀进程", async () => {
  const { app, state, cleanup } = mkApp({ probe: async () => CHAT })
  fs.mkdirSync(path.dirname(app.portFile), { recursive: true })
  fs.writeFileSync(app.portFile, "5123")
  try {
    const r = await app.up()
    assert.deepEqual(r, { port: 5123, already: true, killed: [] })
    assert.equal(state.launched, 0)
    assert.deepEqual(state.killed, [])
  } finally {
    cleanup()
  }
})

test("豆包在跑但没开 CDP：不给 --force 就报 app_busy，并提示 dws start --force", async () => {
  const { app, state, cleanup } = mkApp({ procs: [{ pid: 999, command: `${BIN} --foo` }] })
  try {
    await assert.rejects(app.up(), (e) => {
      assert.equal(e.code, "app_busy")
      assert.match(e.message, /dws start --force/)
      assert.match(e.message, /PID 999/)
      return true
    })
    assert.deepEqual(state.killed, [], "没 --force 绝不能杀进程")
    assert.equal(state.launched, 0)
  } finally {
    cleanup()
  }
})

test("我们自己的残留进程（端口已失效）也一样挡住启动，要 --force 才清场", async () => {
  const { app, state, cleanup } = mkApp()
  // 命令行里带我们自己的 profile：这是 dws 起过、但 CDP 端口已经失效的残留
  state.procs = [{ pid: 777, command: `${BIN} --remote-debugging-port=1 --user-data-dir=${app.profile}` }]
  try {
    const st = await app.status()
    assert.equal(st.port, 0)
    assert.equal(st.foreign.length, 0)
    await assert.rejects(app.up(), (e) => e.code === "app_busy")
  } finally {
    cleanup()
  }
})

test("--force：先杀掉在跑的豆包，再独占启动", async () => {
  const { app, state, cleanup } = mkApp({ procs: [{ pid: 999, command: `${BIN} --foo` }] })
  try {
    const r = await app.up({ force: true })
    assert.equal(r.port, 4400)
    assert.equal(r.already, false)
    assert.deepEqual(r.killed, [999])
    assert.deepEqual(state.killed, [999])
    assert.equal(state.launched, 1)
    assert.equal(state.procs.length, 0)
  } finally {
    cleanup()
  }
})

test("没有豆包在跑：直接独占启动", async () => {
  const { app, state, cleanup } = mkApp()
  try {
    const r = await app.up()
    assert.equal(r.port, 4400)
    assert.deepEqual(r.killed, [])
    assert.equal(state.launched, 1)
  } finally {
    cleanup()
  }
})

test("shutdown 杀完把失效的端口文件清掉", async () => {
  const { app, state, cleanup } = mkApp({ procs: [{ pid: 888, command: `${BIN} --foo` }] })
  try {
    fs.mkdirSync(path.dirname(app.portFile), { recursive: true })
    fs.writeFileSync(app.portFile, "5123")
    const r = await app.shutdown()
    assert.deepEqual(r.pids, [888])
    assert.equal(fs.existsSync(app.portFile), false)
    assert.equal(state.procs.length, 0)
  } finally {
    cleanup()
  }
})

// --force 会杀掉豆包。从豆包会话里发出的命令一旦真杀，回复就没了：必须先拒。
test("从豆包会话里发出的 --force 被拒，一个进程都不杀", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dws-start-cli-"))
  const env = {
    ...process.env,
    HOME: cwd,
    DOUBAO_WORK_HOME: path.join(cwd, "profile"),
    MCP_VM_CONVERSATION_ID: "38453052825833730",
  }
  try {
    const r = spawnSync(process.execPath, [CLI, "start", "--force"], { cwd, encoding: "utf8", timeout: 20000, env })
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /拒绝 --force/)
    assert.match(r.stderr, /终端/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
