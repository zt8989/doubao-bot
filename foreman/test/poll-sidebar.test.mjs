// 轮询不再把窗口拽到被监听会话：还在跑的会话只读侧边栏，不逐条 dws status（status 内部要 goto）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pollOnce } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function mkCtx({ runningMap, status, notify }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-poll-sidebar-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    notify: { enabled: true, session: "boss", events: ["done"] },
    deliver: { mode: "existing" },
  }
  const book = new Book(cfg.stateFile)
  book.setWatch({ target: "conv-a", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
  const calls = { status: 0, info: 0, notified: [] }
  const ctx = {
    cfg,
    state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
    log: () => {},
    gitea: {},
    dws: {
      runningMap,
      status: async (...a) => { calls.status++; return status(...a) },
      info: async () => { calls.info++; return { lastReply: '<RESULT>{"status":"done","summary":"做完了"}</RESULT>' } },
      notify: async (target, text) => { calls.notified.push({ target, text }); return notify?.(target, text) },
    },
  }
  return { ctx, calls, dir }
}

test("侧边栏显示还在跑：不调用 dws.status，也就不切窗口", async () => {
  const { ctx, calls, dir } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: true, title: "w" } }),
    status: async () => { throw new Error("在跑的会话不该去读 status") },
  })
  try {
    const r = await pollOnce(ctx)
    assert.equal(r.checked, 1)
    assert.equal(r.notified, 0)
    assert.equal(calls.status, 0)
    assert.equal(calls.info, 0)
    assert.equal(calls.notified.length, 0)
    assert.equal(ctx.state.watchers.get("conv-a").lastPhase, "running")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏显示没在跑：照常读 status 并投递结论", async () => {
  const { ctx, calls, dir } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: false, title: "w" } }),
    status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
  })
  try {
    const r = await pollOnce(ctx)
    assert.equal(calls.status, 1)
    assert.equal(r.notified, 1)
    assert.equal(calls.notified.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏读不到：退回逐条 status，不漏通知", async () => {
  const { ctx, calls, dir } = mkCtx({
    runningMap: async () => { throw new Error("list 失败") },
    status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
  })
  try {
    const r = await pollOnce(ctx)
    assert.equal(calls.status, 1)
    assert.equal(r.notified, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("收工那一轮处理完就落 idle，下一轮不再读 status", async () => {
  const { ctx, calls, dir } = mkCtx({
    runningMap: async () => ({ "conv-a": { running: false, title: "w" } }),
    status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
  })
  try {
    await pollOnce(ctx)
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

test("侧边栏又报 running：清掉 idle，收工后再判一轮并再通知", async () => {
  let running = true
  const { ctx, calls, dir } = mkCtx({
    runningMap: async () => ({ "conv-a": { running, title: "w" } }),
    status: async () => ({ streaming: false, finished: true, chars: 900, head: "H2", tail: "T2", status: "ok" }),
  })
  try {
    new Book(ctx.cfg.stateFile).markIdle("conv-a")
    await pollOnce(ctx) // 在跑：只记一笔，不读 status
    assert.equal(calls.status, 0)
    assert.equal(new Book(ctx.cfg.stateFile).notified["conv-a"].idle, false)
    running = false
    const r2 = await pollOnce(ctx) // 收工：读一次 status，指纹变了要再通知
    assert.equal(calls.status, 1)
    assert.equal(r2.notified, 1)
    assert.equal(calls.notified.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("侧边栏里没有这条、但上次已通知过：不再读 status", async () => {
  const { ctx, calls, dir } = mkCtx({
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
  const { ctx, calls, dir } = mkCtx({
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
  const { ctx, calls, dir } = mkCtx({
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
    assert.equal(r2.notified, 1)
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
