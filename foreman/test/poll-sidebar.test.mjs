// 轮询不再把窗口拽到被监听会话：还在跑的会话只读侧边栏，不逐条 dws status（status 内部要 goto）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pollOnce } from "../src/service.mjs"
import { Book } from "../src/book.mjs"
import { InboxStore, AgentWorker } from "../src/inbox.mjs"
import { deliverTaskUpdate } from "../src/taskevents.mjs"

function mkCtx({ runningMap, status, notify }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-poll-sidebar-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    notify: { enabled: true, session: "boss", events: ["done"] },
    deliver: { mode: "existing" },
  }
  const book = new Book(cfg.stateFile)
  book.setWatch({ target: "conv-a", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
  const calls = { status: 0, info: 0, notified: [], queued: [] }
  const inbox = new InboxStore(new DatabaseSync(path.join(dir, "console.db")))
  const ctx = {
    cfg,
    inbox,
    book,
    state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
    log: () => {},
    gitea: {},
    dws: {
      runningMap,
      status: async (...a) => { calls.status++; return status(...a) },
      info: async () => { calls.info++; return { lastReply: "做完了，已提交并通过测试。" } },
      queue: async (target, text) => { calls.queued.push({ target, text }) },
      notify: async (target, text) => { calls.notified.push({ target, text }); return notify?.(target, text) },
    },
  }
  const worker = new AgentWorker({ store: inbox, retryMs: 0, handlers: { "task.update": async (batch) => {
    for (const event of batch) await deliverTaskUpdate(ctx, event)
  } } })
  return { ctx, calls, dir, inbox, drain: () => worker.runOnce() }
}

test("侧边栏显示还在跑：不调用 dws.status，也就不切窗口", async () => {
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: true, title: "w" } }),
    status: async () => { throw new Error("在跑的会话不该去读 status") },
  })
  try {
    const r = await pollOnce(ctx)
    assert.equal(r.checked, 1)
    assert.equal(r.notified, 0)
    assert.equal(ctx.state.lastPollResult, "检查 1 · 收工 0 · 通知 0 · 续跑 0")
    assert.equal(calls.status, 0)
    assert.equal(calls.info, 0)
    assert.equal(calls.notified.length, 0)
    assert.equal(ctx.state.watchers.get("conv-a").lastPhase, "running")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏显示没在跑：最终回复先入 Inbox，Worker 才 queue 并消费指纹", async () => {
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: false, title: "w" } }),
    status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
  })
  try {
    const r = await pollOnce(ctx)
    assert.equal(calls.status, 1)
    assert.equal(r.notified, 0)
    assert.equal(calls.notified.length, 0, "poll 不直接发消息")
    assert.equal(calls.queued.length, 0)
    await drain()
    assert.equal(calls.queued.length, 1)
    assert.equal(calls.queued[0].target, "boss")
    assert.match(new Book(ctx.cfg.stateFile).notified["conv-a"].fingerprint, /^[0-9a-f]{12}$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏读不到：首个最终回复由 Worker 消费，之后同一会话进入 idle，不重复 status", async () => {
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => { throw new Error("list 失败") },
    status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
  })
  try {
    const r = await pollOnce(ctx)
    assert.equal(calls.status, 1)
    assert.equal(r.notified, 0)
    assert.equal(calls.notified.length, 0)
    await drain()
    assert.ok(new Book(ctx.cfg.stateFile).notified["conv-a"])
    await pollOnce(ctx)
    assert.equal(calls.status, 1, "RESULT 已消费且没有 running 信号，不应再读 status")
    assert.equal(calls.info, 1, "RESULT 已消费，也不应再读 info")
    assert.equal(ctx.state.watchers.get("conv-a").lastPhase, "idle")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("收工那一轮处理完就落 idle，下一轮不再读 status", async () => {
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: false, title: "w" } }),
    status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
  })
  try {
    await pollOnce(ctx)
    await drain()
    assert.equal(calls.status, 1)
    assert.equal(new Book(ctx.cfg.stateFile).notified["conv-a"].idle, true)
    const r2 = await pollOnce(ctx)
    assert.equal(r2.checked, 1)
    assert.equal(calls.status, 1, "第二轮到 idle 了，不该再读 status")
    assert.equal(calls.info, 1, "也不该再读 info")
    assert.equal(ctx.state.watchers.get("conv-a").lastPhase, "idle")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("续跑后先读到旧完成指纹：不重新 idle，新结果仍会被消费", async () => {
  const oldStatus = { streaming: false, finished: true, chars: 500, head: "H1", tail: "T1", status: "ok" }
  const newStatus = { streaming: false, finished: true, chars: 900, head: "H2", tail: "T2", status: "ok" }
  let currentStatus = oldStatus
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: false, title: "w" } }),
    status: async () => currentStatus,
    notify: async () => ({ ok: true }),
  })
  try {
    await pollOnce(ctx)
    await drain()
    const first = new Book(ctx.cfg.stateFile).notified["conv-a"]
    assert.equal(first.idle, true)
    assert.equal(calls.info, 1)

    // resumeWorker 先 clearIdle，再 steer；侧边栏来不及报 running 时，status 仍可能还是上一轮。
    new Book(ctx.cfg.stateFile).clearIdle("conv-a")
    await pollOnce(ctx)
    const waiting = new Book(ctx.cfg.stateFile).notified["conv-a"]
    assert.equal(waiting.idle, false, "唤醒后的旧指纹只是残留状态，不能把监听重新休眠")
    assert.equal(calls.info, 1, "旧指纹不重复消费")

    currentStatus = newStatus
    await pollOnce(ctx)
    await drain()
    const finished = new Book(ctx.cfg.stateFile).notified["conv-a"]
    assert.equal(calls.info, 2, "续跑后的新指纹必须继续回收")
    assert.notEqual(finished.fingerprint, first.fingerprint)
    assert.equal(finished.idle, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏又报 running：清掉 idle，收工后再判一轮并再通知", async () => {
  let running = true
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-a": { running, title: "w" } }),
    status: async () => ({ streaming: false, finished: true, chars: 900, head: "H2", tail: "T2", status: "ok" }),
  })
  try {
    new Book(ctx.cfg.stateFile).markIdle("conv-a")
    await pollOnce(ctx) // 在跑：只记一笔，不读 status
    assert.equal(calls.status, 0)
    assert.equal(new Book(ctx.cfg.stateFile).notified["conv-a"].idle, false)
    running = false
    const r2 = await pollOnce(ctx) // 收工：入箱后由 Worker 消费新指纹
    await drain()
    assert.equal(calls.status, 1)
    assert.equal(r2.notified, 0)
    assert.equal(calls.notified.length, 0, "不发任何消息")
    assert.match(new Book(ctx.cfg.stateFile).notified["conv-a"].fingerprint, /^[0-9a-f]{12}$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏里没有这条、但上次已通知过：不再读 status", async () => {
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-b": { running: false, title: "别的会话" } }),
    status: async () => { throw new Error("不在侧边栏收工过的会话不该再读 status") },
  })
  try {
    new Book(ctx.cfg.stateFile).markNotified("conv-a", "fp123", { phase: "finished", chars: 500 })
    await pollOnce(ctx)
    assert.equal(calls.status, 0)
    assert.equal(ctx.state.watchers.get("conv-a").lastPhase, "gone")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏里没有这条、也从没通知过：只记 gone，不读 status", async () => {
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => ({ "conv-b": { running: false, title: "别的会话" } }),
    status: async () => { throw new Error("不在侧边栏的会话不该读 status") },
  })
  try {
    await pollOnce(ctx)
    assert.equal(calls.status, 0)
    assert.equal(new Book(ctx.cfg.stateFile).notified["conv-a"].gone, true)
    assert.equal(ctx.state.watchers.get("conv-a").lastPhase, "gone")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("gone 之后又出现在侧边栏：清 gone 并重新判一轮", async () => {
  let present = false
  const { ctx, calls, dir, drain } = mkCtx({
    runningMap: async () => (present ? { "conv-a": { running: false, title: "w" } } : { "conv-b": { running: false, title: "别的会话" } }),
    status: async () => ({ streaming: false, finished: true, chars: 700, head: "H", tail: "T", status: "ok" }),
  })
  try {
    await pollOnce(ctx)
    assert.equal(calls.status, 0)
    assert.equal(new Book(ctx.cfg.stateFile).notified["conv-a"].gone, true)
    present = true
    const r2 = await pollOnce(ctx)
    assert.equal(calls.status, 1)
    assert.equal(r2.notified, 0)
    assert.ok(!new Book(ctx.cfg.stateFile).notified["conv-a"].gone)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("PR 已合并（会话已归档）：不再给编排会话补一条结论通知，但 notify 节点照样落痕", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-poll-archived-"))
  try {
    const cfg = { stateFile: path.join(dir, "state.json"), notify: { enabled: true, session: "boss", events: ["done"] }, deliver: { mode: "existing" } }
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-a", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    book.setIssue("demo/demo#1", { state: "done", pr: 12 })
    book.markMergeAsked("demo/demo#12", { pr: 12, status: "merged" })
    const events = []
    const calls = { notified: 0 }
    const ctx = {
      cfg,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      engine: { lifecycle: { emit: async (e, p) => events.push([e, p.kind]) }, emit: async () => {} },
      dws: {
        runningMap: async () => ({ "conv-a": { running: false, title: "w" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({ lastReply: '<RESULT>{"status":"done","pr":12}</RESULT>' }),
        notify: async () => { calls.notified++ },
      },
    }
    const r = await pollOnce(ctx)
    assert.equal(r.notified, 0, "已合并归档的单不再通知编排会话")
    assert.equal(calls.notified, 0)
    assert.deepEqual(events, [["notice.delivered", "archived-skip"]], "notify 节点落一次「跳过」的痕，别一直挂待跑")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("普通最终回复：只入 Inbox，由 Worker 投给编排，不拼整段对话、不判失败", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-poll-final-reply-"))
  try {
    const cfg = {
      stateFile: path.join(dir, "state.json"),
      notify: { enabled: true, session: "boss", events: ["done", "failed"] },
      deliver: { mode: "existing" },
      sessionFlow: { enabled: true },
    }
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-worker", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    book.setIssue("demo/demo#1", { state: "working", title: "统一路由", orchestrator: "conv-orch" })
    const queued = []
    const inbox = new InboxStore(new DatabaseSync(path.join(dir, "console.db")))
    const ctx = {
      cfg, inbox, book,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      engine: { lifecycle: { emit: async () => {} }, emit: async () => {} },
      dws: {
        runningMap: async () => ({ "conv-worker": { running: false, title: "w" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({
          lastReply: "已补齐回归测试并提交。",
          messages: [{ role: "assistant", text: "不应把整段历史塞进通知。" }],
        }),
        queue: async (target, text) => { queued.push({ target, text }) },
      },
    }
    const worker = new AgentWorker({ store: inbox, retryMs: 0, handlers: { "task.update": async (batch) => {
      for (const event of batch) await deliverTaskUpdate(ctx, event)
    } } })

    await pollOnce(ctx)
    assert.equal(queued.length, 0, "poll 只入箱，不直接投递")
    assert.equal(new Book(cfg.stateFile).notified["conv-worker"], undefined)
    await worker.runOnce()
    assert.equal(queued.length, 1)
    assert.equal(queued[0].target, "conv-orch")
    assert.match(queued[0].text, /已补齐回归测试并提交。/)
    assert.doesNotMatch(queued[0].text, /不应把整段历史塞进通知/)
    assert.equal(new Book(cfg.stateFile).issue("demo/demo#1").state, "working", "业务状态只由编排判断")
    assert.equal(new Book(cfg.stateFile).notified["conv-worker"].idle, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("Worker queue 失败：事件留在 Inbox，任务不 idle；重试成功后才消费", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-poll-queue-retry-"))
  try {
    const cfg = {
      stateFile: path.join(dir, "state.json"),
      notify: { enabled: true, session: "auto", maxAttempts: 2, events: ["done", "failed"] },
      deliver: { mode: "existing" },
      sessionFlow: { enabled: true },
    }
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-worker", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1 })
    book.setIssue("demo/demo#1", { state: "working", title: "测试单", orchestrator: "conv-orch" })
    let fail = true
    const queued = []
    const inbox = new InboxStore(new DatabaseSync(path.join(dir, "console.db")))
    const ctx = {
      cfg, inbox, book,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      engine: { lifecycle: { emit: async () => {} }, emit: async () => {} },
      dws: {
        runningMap: async () => ({ "conv-worker": { running: false, title: "w" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({ lastReply: "改完了，已 commit。" }),
        queue: async (target, text) => {
          if (fail) { fail = false; throw new Error("queue failed") }
          queued.push({ target, text })
        },
      },
    }
    const worker = new AgentWorker({ store: inbox, retryMs: 0, handlers: { "task.update": async (batch) => {
      for (const event of batch) await deliverTaskUpdate(ctx, event)
    } } })

    const r1 = await pollOnce(ctx)
    assert.equal(r1.enqueued, 1)
    await worker.runOnce()
    assert.equal(new Book(cfg.stateFile).notified["conv-worker"], undefined, "投递失败不能 idle 或消费指纹")
    assert.equal(inbox.list("pending").filter((event) => event.kind === "task.update").length, 1)

    const r2 = await pollOnce(ctx)
    assert.equal(r2.enqueued, 0, "同一任务已有 pending 事件，不重复制造")
    await worker.runOnce()
    assert.equal(queued.length, 1)
    assert.equal(queued[0].target, "conv-orch")
    assert.equal(new Book(cfg.stateFile).notified["conv-worker"].idle, true, "送达后才落 idle")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
