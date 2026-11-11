import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, pingOnce } from "../src/service.mjs"
import { ensureService, ServiceError, callRaw } from "../src/svclient.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-hs-"))
}

function mkCfg(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    pollSeconds: 20,
    notify: { enabled: true, session: "auto", events: ["done"] },
    service: {
      socket: path.join(dir, "foreman.sock"),
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 800,
      stopTimeoutMs: 500,
      enabled: true,
    },
    ...over,
  }
}

function fakeDws() {
  return {
    status: async () => null,
    info: async () => ({ lastReply: "" }),
    notify: async () => ({}),
  }
}

test("真实起服务 → 客户端 ping 通；--no-service 返回 skipped 且不 spawn", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    server = await startServer({ cfg, book: new Book(cfg.stateFile), dws: fakeDws(), log: () => {} })

    // ping 直接通
    const p = await pingOnce(cfg.service.socket, 1000)
    assert.equal(p.ok, true)
    assert.ok(p.pid > 0)

    // 已经在跑 → ensureService 返回 started:false，不调用 spawnFn
    let spawned = 0
    const r = await ensureService({
      cfg,
      noService: false,
      spawnFn: () => {
        spawned++
        return { pid: 999 }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.started, false)
    assert.equal(spawned, 0)

    // --no-service：不 ping 不 spawn
    const calledSpawn = { n: 0 }
    const r2 = await ensureService({
      cfg,
      noService: true,
      spawnFn: () => {
        calledSpawn.n++
        return { pid: 999 }
      },
    })
    assert.equal(r2.ok, false)
    assert.equal(r2.skipped, "no-service")
    assert.equal(calledSpawn.n, 0)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("服务不在 → spawnFn 被调用，握手成功返回 started:true", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    // 先在后台真起一个服务作为 spawnFn 的产物
    server = await startServer({ cfg, book: new Book(cfg.stateFile), dws: fakeDws(), log: () => {} })
    await server.close()
    server = null
    // 此时 socket/pid 都没了（close 清掉）。spawnFn 里再起一个。
    const spawned = []
    const r = await ensureService({
      cfg,
      spawnFn: async () => {
        const s = await startServer({ cfg, book: new Book(cfg.stateFile), dws: fakeDws(), log: () => {} })
        spawned.push(s)
        return { pid: process.pid }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.started, true)
    assert.equal(spawned.length, 1)
    // 能 ping 通
    const p = await pingOnce(cfg.service.socket, 1000)
    assert.equal(p.ok, true)
    await spawned[0].close()
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("spawn 后迟迟握不上手 → 抛 ServiceError(service_unavailable)，message 可定位", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { service: { ...mkCfg(dir).service, handshakeTimeoutMs: 300 } })
    // spawnFn 什么都不起，只返回一个假 child —— ping 永远不通
    await assert.rejects(
      () =>
        ensureService({
          cfg,
          spawnFn: () => ({ pid: 42 }),
        }),
      (e) => {
        assert.ok(e instanceof ServiceError)
        assert.equal(e.code, "service_unavailable")
        assert.match(e.message, /超时|握手/)
        return true
      }
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("callRaw 走通 ping 帧（id 对齐）", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    server = await startServer({ cfg, book: new Book(cfg.stateFile), dws: fakeDws(), log: () => {} })
    const r = await callRaw(cfg.service.socket, { id: "cli", cmd: "ping" }, 2000)
    assert.equal(r.ok, true)
    assert.equal(r.id, "cli")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
