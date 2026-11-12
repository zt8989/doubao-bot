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
