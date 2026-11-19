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

test("PR 通知 done 后同键不再入队，避免每轮扫描重复投递", () => {
  const { store } = fixture()
  const payload = { type: "pr.candidates", text: "同一条 PR 通知", json: { prs: [] } }
  const dedupeKey = "router:notice:3fd5a1b43bf3cecd2391369bbfd3a7a4b9a821a007f114c6df7dc17cdaf9c7ac"
  const first = store.enqueue({ kind: "router.notice", text: "同一条 PR 通知", payload, dedupeKey })
  store.complete([first.id])

  const duplicate = store.enqueue({ kind: "router.notice", text: "同一条 PR 通知", payload, dedupeKey })
  assert.equal(duplicate.status, "dropped")
  assert.equal(duplicate.reason, "duplicate-delivered")
  assert.equal(store.list().filter((event) => event.status === "pending").length, 0)
})

test("普通通知 done 后仍允许同键再次入队", () => {
  const { store } = fixture()
  const first = store.enqueue({ kind: "router.notice", text: "每日巡检", dedupeKey: "daily:summary" })
  store.complete([first.id])

  const next = store.enqueue({ kind: "router.notice", text: "每日巡检", dedupeKey: "daily:summary" })
  assert.equal(next.status, "pending")
  assert.notEqual(next.id, first.id)
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

test("Schedule script 无有效信息时只推进时间，不写执行完成回执", async () => {
  const { store } = fixture()
  const calls = []
  const scheduler = new ScheduleRunner({
    store,
    executors: {
      demo: { type: "script", run: async (_, options) => { calls.push(options); return { ok: true, checked: 3 } } },
    },
  })
  scheduler.sync([{ id: "demo", kind: "demo", cron: "*/10 * * * *", enabled: true }], new Date("2026-11-19T00:00:00Z"))
  const fired = await scheduler.tick(new Date("2026-11-19T00:00:00Z"))
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, "schedule.noop")
  assert.equal(fired[0].status, "skipped")
  assert.equal(fired[0].reason, "no-effective-event")
  assert.deepEqual(calls, [{ manual: false }])
  assert.equal(store.count(), 0)
  const schedule = store.schedules()[0]
  assert.equal(schedule.payload.executor, "script")
  assert.ok(Date.parse(schedule.nextAt) > Date.parse("2026-11-19T00:00:00Z"))
  assert.deepEqual(await scheduler.tick(new Date("2026-11-19T00:00:01Z")), [])

  const worker = new AgentWorker({ store, handlers: {} })
  const out = await worker.runOnce(new Date("2026-11-19T00:00:02Z"))
  assert.equal(out.claimed, 0)
})

test("Schedule agent 手动执行成功不写 queued 回执", async () => {
  const { store } = fixture()
  const calls = []
  const scheduler = new ScheduleRunner({
    store,
    executors: {
      router: { type: "agent", run: async (_, options) => { calls.push(options); return { ok: true, action: "queued", convId: "router-1" } } },
    },
  })
  scheduler.sync([{ id: "router", kind: "router", cron: "*/10 * * * *", enabled: false }])
  const fired = await scheduler.runNow("router")
  assert.equal(fired.executor, "agent")
  assert.deepEqual(calls, [{ manual: true }])
  assert.equal(fired.result.convId, "router-1")
  assert.equal(fired.kind, "schedule.noop")
  assert.equal(fired.id, null)
  assert.equal(store.count(), 0)
  assert.equal(store.schedules()[0].payload.executor, "agent")
})

test("Schedule 执行失败也写结果并推进 next_at，不重复运行同一轮业务", async () => {
  const { store } = fixture()
  let calls = 0
  const scheduler = new ScheduleRunner({
    store,
    executors: {
      broken: { type: "script", run: async () => { calls++; throw new Error("script failed") } },
    },
  })
  scheduler.sync([{ id: "broken", kind: "broken", cron: "* * * * *", enabled: true }], new Date("2026-11-19T00:00:00Z"))
  const dueAt = store.schedules()[0].nextAt
  const fired = await scheduler.tick(new Date("2026-11-19T00:01:01Z"))
  assert.equal(calls, 1)
  assert.equal(fired[0].result.ok, false)
  assert.match(fired[0].result.error, /script failed/)
  assert.match(store.get(fired[0].id).text, /执行失败/)
  assert.equal(fired[0].kind, "schedule.event")
  assert.equal(fired[0].type, "schedule.error")
  assert.equal(store.get(fired[0].id).payload.json.error, "script failed")
  assert.ok(Date.parse(store.schedules()[0].nextAt) > Date.parse(dueAt))
  assert.deepEqual(await scheduler.tick(new Date("2026-11-19T00:01:02Z")), [])
  assert.equal(calls, 1)
})

test("脚本显式返回 type/text/json 时，Worker 按 type 直接处理", async () => {
  const { store } = fixture()
  const scheduler = new ScheduleRunner({
    store,
    executors: {
      demo: { type: "script", run: async () => ({ ok: true, inbox: { type: "demo.activity", text: "发现两条有效记录", json: { records: [1, 2] } } }) },
    },
  })
  scheduler.sync([{ id: "demo", kind: "demo", cron: "*/10 * * * *", enabled: false }])
  const fired = await scheduler.runNow("demo")
  assert.equal(fired.kind, "schedule.event")
  assert.equal(fired.type, "demo.activity")
  const event = store.get(fired.id)
  assert.deepEqual(event.payload.json, { records: [1, 2] })
  assert.equal(event.payload.scheduleId, "demo")

  const handled = []
  const worker = new AgentWorker({
    store,
    handlers: { "demo.activity": async (input) => { handled.push(input); return { ok: true } } },
  })
  const out = await worker.runOnce()
  assert.equal(out.ok, true)
  assert.equal(handled.length, 1)
  assert.equal(handled[0].kind, "demo.activity")
  assert.deepEqual(handled[0].payload, { records: [1, 2] })
  assert.equal(store.counts().done, 1)
})

test("Worker 无法识别 schedule.event 的 type 时交 router agent 判断", async () => {
  const { store } = fixture()
  store.enqueue({
    kind: "schedule.event",
    text: "",
    payload: { type: "custom.unknown", text: "", json: { reason: "需要语义判断", value: 7 } },
  })
  store.enqueue({
    kind: "router.notice",
    text: "PR #1",
    payload: { type: "pr.candidates", text: "PR #1", json: { prs: [{ key: "demo/demo#1" }] } },
  })
  const runs = []
  const worker = new AgentWorker({
    store,
    handlers: { router: async (input) => { runs.push(input); return { ok: true } } },
  })
  const out = await worker.runOnce()
  assert.equal(out.ok, true)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].scheduled, false)
  assert.equal(runs[0].notices.length, 2)
  assert.match(runs[0].notices[0], /"reason": "需要语义判断"/)
  assert.match(runs[0].notices[0], /"value": 7/)
  assert.match(runs[0].notices[1], /^PR #1/)
  assert.match(runs[0].notices[1], /"key": "demo\/demo#1"/)
  assert.equal(store.counts().done, 2)
})

test("Worker 丢弃旧 schedule.result，不再确认或转发执行完成噪音", async () => {
  const { store } = fixture()
  store.enqueue({ kind: "schedule.result", text: "prWatch 脚本执行完成", payload: { result: { ok: true, checked: 8 } } })
  const worker = new AgentWorker({ store, handlers: {} })
  const out = await worker.runOnce()
  assert.equal(out.ok, true)
  assert.equal(out.completed, 0)
  assert.equal(store.counts().dropped, 1)
  assert.equal(store.list()[0].reason, "non-actionable")
})

test("邮件只检查时无事件，有实际回复或验收活动时写 JSON 事件", async () => {
  const { store } = fixture()
  let result = { ok: true, checked: 12, matched: 0, routed: 0, verdicts: 0, steered: 0, merged: 0, reminders: 0 }
  const scheduler = new ScheduleRunner({
    store,
    executors: { mail: { type: "script", run: async () => result } },
  })
  scheduler.sync([{ id: "mail", kind: "mail", cron: "*/10 * * * *", enabled: false }])
  assert.equal((await scheduler.runNow("mail")).kind, "schedule.noop")
  assert.equal(store.count(), 0)
  result = { ...result, routed: 1, verdicts: 1, steered: 1 }
  const fired = await scheduler.runNow("mail")
  assert.equal(fired.type, "mail.activity")
  assert.equal(store.get(fired.id).payload.type, "mail.activity")
  assert.equal(store.get(fired.id).payload.json.routed, 1)
  assert.equal(store.get(fired.id).payload.json.verdicts, 1)
})

test("邮件只路由普通回复时不入箱，避免每封回信都刷一条事件", async () => {
  const { store } = fixture()
  const scheduler = new ScheduleRunner({
    store,
    executors: { mail: { type: "script", run: async () => ({ ok: true, checked: 30, routed: 1, matched: 0, verdicts: 0, steered: 0, merged: 0, reminders: 0 }) } },
  })
  scheduler.sync([{ id: "mail", kind: "mail", cron: "*/10 * * * *", enabled: false }])
  assert.equal((await scheduler.runNow("mail")).kind, "schedule.noop")
  assert.equal(store.count(), 0)
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
