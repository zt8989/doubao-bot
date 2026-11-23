import test from "node:test"
import assert from "node:assert/strict"
import { NoopSessionAdapter } from "../src/workflow/adapters/noop.mjs"
import { makeSessionAdapter, assertSessionAdapter } from "../src/workflow/adapters/session.mjs"

test("noop 适配器：契约方法齐全，开/投递返回假 convId，status 恒为已完成空文本", async () => {
  const logs = []
  const a = new NoopSessionAdapter({ log: (m) => logs.push(m) })
  assertSessionAdapter(a, "noop")

  const ex = a.openExecution({ name: "工单编排", repo: "yyzl/win-ai-harness", prompt: "随便什么" })
  assert.equal(ex.ok, true)
  assert.match(ex.convId, /^noop-/)
  assert.equal(ex.noop, true)

  const dv = a.deliver({ name: "通知会话", prompt: "x" })
  assert.match(dv.convId, /^noop-/)
  assert.equal(dv.noop, true)
  assert.equal(a.open({ name: "旧调用面" }).ok, true)
  assert.equal(a.send("s", "文本").ok, true)
  assert.equal(a.resumeExecution({ name: "s" }).ok, true)
  assert.equal(a.notify("s", "文本").ok, true)
  assert.equal(a.steer("s", "更新").ok, true)
  assert.equal(a.queue("s", "排一条").ok, true)
  assert.equal(await a.archive("s").then((r) => r.ok), true)
  assert.equal(a.start().ok, true)
  assert.deepEqual(await a.busyWatchers(), [])

  const st = a.status("s")
  assert.equal(st.streaming, false)
  assert.equal(st.finished, true)
  assert.equal(st.chars, 0)
  const info = a.info("s")
  assert.equal(info.lastReply, "")
  assert.deepEqual(info.messages, [])
  // noop 的侧边栏恒空：tasks/巡检读不到任何「还在跑」
  assert.deepEqual(await a.runningMap(), {})
  // 动作有留痕（noop 不是静默丢）
  assert.ok(logs.some((m) => m.includes("noop open")))
})

test("makeSessionAdapter：agent=noop 选 Noop，缺省也选 Noop（默认不碰豆包），dws 显式才选豆包", () => {
  assert.equal(makeSessionAdapter({ agent: "noop" }).constructor.name, "NoopSessionAdapter")
  assert.equal(makeSessionAdapter({ agent: "NOOP" }).constructor.name, "NoopSessionAdapter")
  assert.equal(makeSessionAdapter({}).constructor.name, "NoopSessionAdapter")
  assert.equal(makeSessionAdapter({ agent: "随便写" }).constructor.name, "NoopSessionAdapter")
  assert.equal(makeSessionAdapter({ agent: "dws" }).constructor.name, "DoubaoSessionAdapter")
})
