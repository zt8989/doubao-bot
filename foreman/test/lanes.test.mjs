// 两条通道：派单与合并分开排队、各用各的并发；合并通道默认一条一条来。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Lane } from "../src/lanes.mjs"
import { mergeOnce } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("Lane：按 limit 并发，超出排队；key 重复提交只跑一次", async () => {
  const lane = new Lane({ name: "t", limit: 1 })
  const order = []
  let running = 0
  let peak = 0
  const task = (tag) => async () => {
    running++
    peak = Math.max(peak, running)
    order.push(`start-${tag}`)
    await sleep(5)
    order.push(`end-${tag}`)
    running--
    return tag
  }
  const a = lane.submit("a", task("a"))
  const b = lane.submit("b", task("b"))
  const dup = lane.submit("a", task("dup"))
  assert.equal(dup, a, "同一个 key 复用同一 promise")
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"])
  await lane.idle()
  assert.equal(peak, 1, "并发 1：第二条等第一条跑完")
  assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b"])
  assert.equal(lane.done, 2)
})

test("Lane：并发 2 时两条同时跑", async () => {
  const lane = new Lane({ name: "t2", limit: 2 })
  let running = 0
  let peak = 0
  const job = async () => {
    running++
    peak = Math.max(peak, running)
    await sleep(5)
    running--
  }
  await Promise.all([lane.submit("1", job), lane.submit("2", job), lane.submit("3", job)])
  assert.equal(peak, 2)
})

test("Lane：一条失败不影响后面的队列，snapshot 报得出在跑与排队", async () => {
  const lane = new Lane({ name: "t3", limit: 1 })
  const bad = lane.submit("bad", async () => { throw new Error("boom") })
  const ok = lane.submit("ok", async () => "done")
  await assert.rejects(() => bad, /boom/)
  assert.equal(await ok, "done")
  const snap = lane.snapshot()
  assert.equal(snap.limit, 1)
  assert.equal(snap.failed, 1)
  assert.equal(snap.done, 1)
  assert.deepEqual(snap.running, [])
})

// ---- 合并通道 ----

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-lane-"))
}

function mkCtx(dir, over = {}) {
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    merge: { enabled: true, style: "merge", deleteBranch: true, concurrency: 1 },
    pickup: { maxRunning: 2 },
    repos: [],
    workHours: { enabled: false },
    notify: { enabled: true, session: "boss" },
    ...over,
  }
  const state = { merge: { lastSweepAt: null, sweeps: 0, lastResult: null } }
  const lane = new Lane({ name: "merge", limit: cfg.merge.concurrency })
  return {
    cfg,
    state,
    log: () => {},
    mergeLane: lane,
    lanes: { merge: lane },
    dws: { notify: async () => {} },
    gitea: {},
  }
}

test("mergeOnce：队列里三条也按并发 1 逐条合，派单通道不受影响", async () => {
  const dir = tmpDir()
  try {
    const book = new Book(path.join(dir, "state.json"))
    for (const n of [11, 12, 13]) {
      book.enqueueMerge(`demo/demo#${n}`, { repo: "demo/demo", pr: n, issue: 0, url: "" })
    }
    const ctx = mkCtx(dir)
    let running = 0
    let peak = 0
    const merged = []
    ctx.gitea = {
      mergePr: async (repo, pr) => {
        running++
        peak = Math.max(peak, running)
        await sleep(5)
        merged.push(pr)
        running--
      },
      closeIssue: async () => {},
    }
    const r = await mergeOnce(ctx)
    await ctx.mergeLane.idle()
    assert.equal(r.queued, 3)
    assert.equal(r.started.length, 3)
    assert.equal(peak, 1, "合并通道 1 并发，不并着合")
    assert.deepEqual(merged, [11, 12, 13])
    const after = new Book(ctx.cfg.stateFile).mergeQueue
    for (const n of [11, 12, 13]) assert.equal(after[`demo/demo#${n}`].status, "merged")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("mergeOnce：已合过的任务不再重入；关掉合并开关就整条通道不动作", async () => {
  const dir = tmpDir()
  try {
    const ctx = mkCtx(dir)
    const book = new Book(ctx.cfg.stateFile)
    book.enqueueMerge("demo/demo#21", { repo: "demo/demo", pr: 21 })
    book.markMergeTask("demo/demo#21", { status: "merged" })
    let merges = 0
    ctx.gitea = { mergePr: async () => { merges++ }, closeIssue: async () => {} }
    const r1 = await mergeOnce(ctx)
    assert.equal(r1.queued, 0)
    assert.equal(merges, 0)

    const off = mkCtx(dir, { merge: { enabled: false, concurrency: 1 } })
    const r2 = await mergeOnce(off)
    assert.equal(r2.skipped, "disabled")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
