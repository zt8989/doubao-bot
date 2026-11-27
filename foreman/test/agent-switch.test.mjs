// 执行载体热切换：ctx.getAgent/setAgent（service）+ /api/agent（consolehttp）。
// 配置写回用真实临时目录；dws 用假对象（noop/zcode 适配器不碰外部前端）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer } from "../src/service.mjs"
import { loadConfig } from "../src/config.mjs"

function tmpCfg(obj = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-agent-"))
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify({
    stateFile: path.join(dir, "state.json"),
    // 端口 0 = 随机空闲端口，别撞线上服务；其余服务文件全隔离到临时目录。
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

test("setAgent：写回配置 + 热换适配器；同值 no-op；坏值报错；在跑会话默认拒绝、force 放行", async () => {
  const { cfg, file } = tmpCfg({ agent: "noop" })
  const log = []
  const dwsFake = { runningMap: async () => ({}) }
  const server = await startServer({ cfg, book: null, driver: dwsFake, log: (m) => log.push(m) })
  try {
    const ctxSet = server.setAgent ?? null
    assert.equal(typeof ctxSet, "function", "startServer 应绑 setAgent")
    assert.equal(typeof server.getAgent, "function")

    // 起始 noop
    assert.equal(server.getAgent().agent, "noop")
    assert.equal(server.getAgent().allowed.join(","), "noop,dws,zcode")

    // noop → zcode：配置写回 + engine.session 换成 ZcodeSessionAdapter
    const r1 = await server.setAgent("zcode")
    assert.equal(r1.ok, true)
    assert.equal(r1.changed, true)
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agent, "zcode")
    assert.equal(server.cfg.agent, "zcode")
    assert.equal(server.engine.session.constructor.name, "ZcodeSessionAdapter")
    assert.equal(server.engine.lifecycle.adapters.session, server.engine.session)
    // setAgent 在 service.startServer 的 ctx 上，server 就是 ctx
    assert.ok(log.some((m) => m.includes("agent 载体切换")))

    // 同值 no-op
    const r2 = await server.setAgent("zcode")
    assert.equal(r2.changed, false)

    // 坏值
    await assert.rejects(server.setAgent("豆包"), /未知载体/)
    await assert.rejects(server.setAgent(""), /未知载体/)

    // zcode → noop，旧载体有在跑会话：默认拒绝（agent_busy），force 放行
    server.engine.session.runningMap = async () => ({ a: { running: true }, b: { running: false } })
    await assert.rejects(server.setAgent("noop"), (e) => e.code === "agent_busy" && e.running === 1)
    const r3 = await server.setAgent("noop", { force: true })
    assert.equal(r3.ok, true)
    assert.equal(r3.runningLeft, 1)
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agent, "noop")
    assert.equal(server.engine.session.constructor.name, "NoopSessionAdapter")
  } finally {
    await server.close()
  }
})

test("/api/agent：GET 当前值；POST 切换与 409/400 路径", async () => {
  const { cfg, file } = tmpCfg({ agent: "noop" })
  const dwsFake = { runningMap: async () => ({}) }
  const server = await startServer({ cfg, book: null, driver: dwsFake, log: () => {} })
  try {
    const port = fs.readFileSync(cfg.service?.http?.portFile ?? path.join(path.dirname(file), "service.port"), "utf8").trim()
    const url = `http://127.0.0.1:${port}`

    let r = await fetch(`${url}/api/agent`)
    assert.equal(r.status, 200)
    let body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.agent, "noop")
    assert.deepEqual(body.allowed, ["noop", "dws", "zcode"])

    // POST 正常切换
    r = await fetch(`${url}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "zcode" }) })
    assert.equal(r.status, 200)
    body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.agent, "zcode")
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agent, "zcode")

    // 在跑会话 → 409 + force 放行
    server.engine.session.runningMap = async () => ({ a: { running: true } })
    r = await fetch(`${url}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "noop" }) })
    assert.equal(r.status, 409)
    body = await r.json()
    assert.equal(body.error, "agent_busy")
    r = await fetch(`${url}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "noop", force: true }) })
    assert.equal(r.status, 200)

    // 坏值 → 400
    r = await fetch(`${url}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "xxx" }) })
    assert.equal(r.status, 400)
    assert.equal((await r.json()).error, "bad_agent")
  } finally {
    await server.close()
  }
})
