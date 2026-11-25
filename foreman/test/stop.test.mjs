// foreman stop：rpc stop 收口（关 http/worker、清 pid/port 文件）；serve 模式才退进程。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, handleRequest } from "../src/service.mjs"
import { loadConfig } from "../src/config.mjs"

function tmpCfg(obj = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-stop-"))
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify({
    stateFile: path.join(dir, "state.json"),
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    ...obj,
  }))
  return { cfg: loadConfig(file), dir, file }
}

test("rpc stop：收口关闭 http、清 pid/port 文件；非 serve 环境不退进程", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg, dir } = tmpCfg()
  const server = await startServer({ cfg, book: null, dws: { runningMap: async () => ({}) }, log: () => {} })
  const pidFile = path.join(dir, "foreman.pid")
  const portFile = path.join(dir, "service.port")
  assert.ok(fs.existsSync(pidFile), "起服务要写 pid 文件")

  const r = await handleRequest({ close: server.close, cfg }, { id: "cli", cmd: "stop" })
  assert.equal(r.ok, true)
  assert.equal(r.stopping, true)
  assert.equal(typeof r.pid, "number")

  // 收口是延迟 10ms 的：等它跑完（关 http、清 pid/port 文件）
  await new Promise((r) => setTimeout(r, 300))
  let down = false
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/ping`, { method: "POST", signal: AbortSignal.timeout(1500) })
  } catch {
    down = true
  }
  assert.equal(down, true, "stop 后 http 应该关掉")
  assert.ok(!fs.existsSync(pidFile), "pid 文件要清掉")
  assert.ok(!fs.existsSync(portFile), "port 文件要清掉")
  // 测试进程还活着（没有 FOREMAN_SERVE 不退）
})

test("rpc stop 重复调用幂等（close 已关过就直通）", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg } = tmpCfg()
  const server = await startServer({ cfg, book: null, dws: { runningMap: async () => ({}) }, log: () => {} })
  const close = server.close
  await close()
  // 第二次 close 不抛（state.closed 直通）
  await close()
  await close()
  assert.ok(true)
})
