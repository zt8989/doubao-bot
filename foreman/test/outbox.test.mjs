import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { OutboxStore, OutboxDispatcher } from "../src/outbox.mjs"
import { startServer } from "../src/service.mjs"

const AT = "2026-11-19T00:00:00.000Z"
function fixture() {
  const db = new DatabaseSync(":memory:")
  const store = new OutboxStore(db)
  return { db, store }
}
function enqueue(store, channel = "mail", extra = {}) {
  return store.enqueue({ channel, payload: { text: channel }, availableAt: AT, ...extra })
}

test("Outbox 写入不直接外发，Dispatcher 按通道发送并记 sent", async () => {
  const { store } = fixture()
  const calls = []
  const mail = enqueue(store, "mail")
  const lark = enqueue(store, "lark")
  const dispatcher = new OutboxDispatcher({
    store,
    handlers: {
      mail: async (event) => { calls.push(event); return { messageId: "msg_mail" } },
      lark: async (event) => { calls.push(event); return { messageId: "om_1" } },
    },
  })
  assert.equal(calls.length, 0)
  const out = await dispatcher.runOnce(new Date(AT))
  assert.equal(out.ok, true)
  assert.equal(out.sent, 2)
  assert.deepEqual(calls.map((event) => event.channel), ["mail", "lark"])
  assert.equal(store.get(mail.id).status, "sent")
  assert.equal(store.get(mail.id).result.messageId, "msg_mail")
  assert.equal(store.get(lark.id).status, "sent")
  assert.equal(store.get(lark.id).result.messageId, "om_1")
})

test("Outbox 列表按状态与通道分页并返回准确总数", () => {
  const { store } = fixture()
  for (let i = 1; i <= 3; i++) enqueue(store, "mail")
  for (let i = 1; i <= 2; i++) enqueue(store, "lark")
  assert.deepEqual(store.list({ limit: 2, offset: 1 }).map((event) => event.id), [4, 3])
  assert.equal(store.count(), 5)
  assert.equal(store.count({ channel: "mail" }), 3)
  assert.equal(store.count({ channel: "lark", status: "pending" }), 2)
  assert.equal(store.list({ limit: 1, offset: 1, channel: "mail" })[0].id, 2)
})

test("Outbox dedupeKey 跨完成状态去重，不重复外发", async () => {
  const { store } = fixture()
  const first = enqueue(store, "lark", { dedupeKey: "notice:pr-1" })
  const duplicate = enqueue(store, "lark", { dedupeKey: "notice:pr-1" })
  assert.equal(duplicate.id, first.id)
  assert.equal(duplicate.duplicate, true)
  assert.equal(store.list().length, 1)
  let calls = 0
  const dispatcher = new OutboxDispatcher({ store, handlers: { lark: async () => { calls++ } } })
  await dispatcher.runOnce(new Date(AT))
  const afterSent = enqueue(store, "lark", { dedupeKey: "notice:pr-1" })
  assert.equal(afterSent.id, first.id)
  assert.equal(afterSent.status, "sent")
  assert.equal(calls, 1)
})

test("外发失败保留 pending，下一轮重试成功后才记 sent", async () => {
  const { store } = fixture()
  const event = enqueue(store)
  let calls = 0
  const dispatcher = new OutboxDispatcher({
    store, retryMs: 1000,
    handlers: { mail: async () => { calls++; if (calls === 1) throw new Error("network") } },
  })
  const failed = await dispatcher.runOnce(new Date(AT))
  assert.equal(failed.ok, false)
  assert.equal(store.get(event.id).status, "pending")
  assert.equal(store.get(event.id).attempts, 1)
  assert.match(store.get(event.id).lastError, /network/)
  assert.equal((await dispatcher.runOnce(new Date("2026-11-19T00:00:00.500Z"))).claimed, 0)
  const retried = await dispatcher.runOnce(new Date("2026-11-19T00:00:01.000Z"))
  assert.equal(retried.ok, true)
  assert.equal(store.get(event.id).status, "sent")
  assert.equal(calls, 2)
})

test("失败后的未来重试等待轮询，不在 wake 链里空转", async () => {
  const { store } = fixture()
  const event = enqueue(store)
  let calls = 0
  const dispatcher = new OutboxDispatcher({
    store, retryMs: 60_000,
    handlers: { mail: async () => { calls++; throw new Error("network") } },
  })
  dispatcher.wake()
  await dispatcher.idle()
  assert.equal(calls, 1)
  assert.equal(dispatcher.runCount, 1)
  assert.equal(store.get(event.id).status, "pending")
  assert.ok(Date.parse(store.get(event.id).availableAt) > Date.now() + 50_000)
  await dispatcher.stop()
})

test("达到 maxAttempts 后进入 failed，并通知业务账本", async () => {
  const { store } = fixture()
  const event = enqueue(store, "mail", { maxAttempts: 1 })
  const failedEvents = []
  const dispatcher = new OutboxDispatcher({
    store,
    handlers: { mail: async () => { throw new Error("auth_required") } },
    onFailed: async (event) => failedEvents.push(event.id),
  })
  const out = await dispatcher.runOnce(new Date(AT))
  assert.equal(out.ok, false)
  assert.equal(store.get(event.id).status, "failed")
  assert.deepEqual(failedEvents, [event.id])
})

test("重启后收回过期 processing 租约并继续投递", async () => {
  const { store } = fixture()
  const event = enqueue(store, "lark")
  assert.equal(store.claimBatch(new Date(AT), { leaseMs: 1000 }).length, 1)
  assert.equal(store.get(event.id).status, "processing")
  let calls = 0
  const dispatcher = new OutboxDispatcher({ store, handlers: { lark: async () => { calls++ } } })
  await dispatcher.runOnce(new Date("2026-11-19T00:00:02.000Z"))
  assert.equal(store.get(event.id).status, "sent")
  assert.equal(calls, 1)
})

test("发送后的本地回调失败不重发外部消息", async () => {
  const { store } = fixture()
  const event = enqueue(store)
  let calls = 0
  const dispatcher = new OutboxDispatcher({
    store,
    handlers: { mail: async () => { calls++ } },
    onSent: async () => { throw new Error("book read-only") },
  })
  const out = await dispatcher.runOnce(new Date(AT))
  assert.equal(out.ok, true)
  assert.equal(store.get(event.id).status, "sent")
  assert.equal(calls, 1)
})

test("服务 RPC 先持久化，Dispatcher 才调用邮件驱动", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-outbox-service-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    pollSeconds: 3600,
    notify: { enabled: false, session: "", events: [] },
    inspector: { enabled: false },
    prWatch: { enabled: false },
    mail: { enabled: false },
    workHours: { enabled: false, days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "23:59", offUntil: "" },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
    },
    outbox: { pollMs: 3600000, retrySeconds: 30, leaseSeconds: 120, maxAttempts: 8 },
  }
  const sent = []
  let server
  try {
    server = await startServer({
      cfg,
      dws: { runningMap: async () => ({}) },
      mail: { send: async (message) => { sent.push(message); return { id: "mail-1" } } },
      log() {},
    })
    const rpc = async (request) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      })
      return response.json()
    }
    const queued = await rpc({
      id: "send", cmd: "send", type: "mail", to: "a@example.com", subject: "S", body: "B", dedupeKey: "mail-1",
    })
    assert.equal(queued.ok, true, JSON.stringify(queued))
    assert.equal(queued.status, "pending")
    await server.dispatcher.idle()
    assert.equal(sent.length, 1, JSON.stringify(server.outbox.get(queued.id)))
    assert.equal(server.outbox.get(queued.id).status, "sent")
    const listed = await rpc({ id: "list", cmd: "outbox list", channel: "mail" })
    assert.equal(listed.ok, true)
    assert.equal(listed.messages.length, 1)
    assert.equal(listed.messages[0].status, "sent")
    const duplicate = await rpc({
      id: "duplicate", cmd: "send", type: "mail", to: "a@example.com", subject: "S", body: "B", dedupeKey: "mail-1",
    })
    assert.equal(duplicate.id, queued.id)
    await server.dispatcher.idle()
    assert.equal(sent.length, 1, "dedupeKey 不得重发")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
