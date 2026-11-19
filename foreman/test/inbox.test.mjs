import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { InboxStore, AgentWorker, ScheduleRunner } from "../src/inbox.mjs"

function fixture() {
  const db = new DatabaseSync(":memory:")
  const store = new InboxStore(db)
  return { db, store }
}

test("Inbox 活跃事件按来源去重，重复写入留 dropped 记录", () => {
  const { store } = fixture()
  const first = store.enqueue({ kind: "inspector.notice", text: "PR #1", dedupeKey: "pr:demo#1" })
  const duplicate = store.enqueue({ kind: "inspector.notice", text: "PR #1", dedupeKey: "pr:demo#1" })
  assert.equal(first.status, "pending")
  assert.equal(duplicate.status, "dropped")
  assert.equal(duplicate.reason, "duplicate")
  assert.equal(store.list().length, 2)
  assert.equal(store.counts().pending, 1)
  assert.equal(store.counts().dropped, 1)
})

test("Inbox 列表按筛选条件分页并返回准确总数", () => {
  const { store } = fixture()
  for (let i = 1; i <= 5; i++) store.enqueue({ kind: "inspector", text: `event-${i}` })
  store.enqueue({ kind: "inspector.notice", text: "duplicate", dedupeKey: "pr:demo#1" })
  store.enqueue({ kind: "inspector.notice", text: "duplicate", dedupeKey: "pr:demo#1" })
  assert.deepEqual(store.list({ limit: 2, offset: 2 }).map((event) => event.text), ["event-5", "event-4"])
  assert.equal(store.count(), 7)
  assert.equal(store.count({ status: "pending" }), 6)
  assert.equal(store.count({ status: "dropped" }), 1)
  assert.equal(store.list({ limit: 2, offset: 0, status: "dropped" }).length, 1)
})

test("同一 Schedule 连续到期只保留最新事件，旧事件标记 superseded", () => {
  const { store } = fixture()
  const oldEvent = store.enqueue({ kind: "inspector", text: "old", coalesceKey: "schedule:inspector" })
  const latest = store.enqueue({ kind: "inspector", text: "latest", coalesceKey: "schedule:inspector" })
  assert.equal(store.get(oldEvent.id).status, "dropped")
  assert.equal(store.get(oldEvent.id).reason, "superseded")
  assert.equal(store.get(latest.id).status, "pending")
  const batch = store.claimBatch(new Date())
  assert.deepEqual(batch.map((event) => event.id), [latest.id])
})

test("Worker 丢弃过期事件，并把巡检与多条 PR 通知合成一次运行", async () => {
  const { store } = fixture()
  store.enqueue({ kind: "inspector", availableAt: "2026-11-19T00:00:00.000Z", expiresAt: "2026-11-18T23:59:00.000Z" })
  store.enqueue({ kind: "inspector", availableAt: "2026-11-19T00:00:00.000Z" })
  store.enqueue({ kind: "inspector.notice", text: "PR #1", availableAt: "2026-11-19T00:00:00.000Z" })
  store.enqueue({ kind: "inspector.notice", text: "PR #2", availableAt: "2026-11-19T00:00:00.000Z" })
  const runs = []
  const worker = new AgentWorker({
    store,
    handlers: { inspector: async (batch) => { runs.push(batch) } },
  })
  const out = await worker.runOnce(new Date("2026-11-19T00:00:00Z"))
  assert.equal(out.ok, true)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].scheduled, true)
  assert.deepEqual(runs[0].notices, ["PR #1", "PR #2"])
  assert.equal(runs[0].events.length, 3)
  assert.equal(store.counts().done, 3)
  assert.equal(store.counts().dropped, 1)
  assert.equal(store.list().find((event) => event.status === "dropped").reason, "expired")
})

test("崩溃恢复时，已过期的 processing 事件只丢弃不再执行", () => {
  const { store } = fixture()
  const event = store.enqueue({ kind: "inspector", availableAt: "2026-11-19T00:00:00.000Z", expiresAt: "2026-11-19T00:00:30.000Z" })
  assert.equal(store.claimBatch(new Date("2026-11-19T00:00:00Z"), { leaseMs: 1000 }).length, 1)
  assert.deepEqual(store.claimBatch(new Date("2026-11-19T00:00:31Z"), { leaseMs: 1000 }), [])
  assert.equal(store.get(event.id).status, "dropped")
  assert.equal(store.get(event.id).reason, "expired")
})

test("Worker 投递失败把整组事件放回 Inbox，下一轮可重试", async () => {
  const { store } = fixture()
  store.enqueue({ kind: "inspector.notice", text: "PR #1", availableAt: "2026-11-19T00:00:00.000Z" })
  let calls = 0
  const worker = new AgentWorker({
    store,
    retryMs: 0,
    handlers: { inspector: async () => { calls++; if (calls === 1) throw new Error("app_unavailable") } },
  })
  const failed = await worker.runOnce(new Date("2026-11-19T00:00:00Z"))
  assert.equal(failed.ok, false)
  assert.equal(store.counts().pending, 1)
  assert.match(store.list()[0].lastError, /app_unavailable/)
  const retried = await worker.runOnce(new Date("2026-11-19T00:00:01Z"))
  assert.equal(retried.ok, true)
  assert.equal(calls, 2)
  assert.equal(store.counts().done, 1)
})

test("Schedule 到期只写 Inbox 并推进下次时间，不直接调用 Agent", () => {
  const { store } = fixture()
  const scheduler = new ScheduleRunner({ store })
  scheduler.sync([{ id: "inspector", kind: "inspector", cron: "*/10 * * * *", enabled: true }], new Date("2026-11-19T00:00:00Z"))
  const fired = scheduler.tick(new Date("2026-11-19T00:00:00Z"))
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, "inspector")
  assert.equal(store.counts().pending, 1)
  const schedule = store.schedules()[0]
  assert.ok(Date.parse(schedule.nextAt) > Date.parse("2026-11-19T00:00:00Z"))
  assert.deepEqual(scheduler.tick(new Date("2026-11-19T00:00:01Z")), [])
})

test("Schedule 写事件失败时回滚 next_at，重启后不会静默丢这一轮", () => {
  const { store } = fixture()
  const scheduler = new ScheduleRunner({ store })
  scheduler.sync([{ id: "broken", kind: "", cron: "* * * * *", enabled: true }], new Date("2026-11-19T00:00:00Z"))
  const dueAt = store.schedules()[0].nextAt
  assert.throws(() => scheduler.tick(new Date("2026-11-19T00:01:01Z")), /缺少 kind/)
  assert.equal(store.schedules()[0].nextAt, dueAt)
})

test("同进程写入后直接 wake Worker，无需等待轮询", async () => {
  const { store } = fixture()
  const runs = []
  const worker = new AgentWorker({ store, handlers: { inspector: async (batch) => runs.push(batch) } })
  store.onChange = () => worker.wake()
  store.enqueue({ kind: "inspector.notice", text: "PR #1" })
  await worker.idle()
  assert.equal(runs.length, 1)
  assert.equal(store.counts().done, 1)
  await worker.stop()
})
