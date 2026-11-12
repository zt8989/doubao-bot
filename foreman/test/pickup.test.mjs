import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { eligible, sortIssues, CLOSED_STATES } from "../src/orchestrator.mjs"
import { pickupOnce } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

const repoCfg = { name: "win-ai-harness", repo: "yyzl/win-ai-harness", dir: "/tmp/x", base: "dev" }

function cfg(over = {}) {
  return {
    maxAttempts: 3,
    pickup: {
      labelIds: [],
      labels: [],
      excludeLabels: ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"],
      onlyUnassigned: true,
      order: "oldest",
      ...over.pickup,
    },
  }
}

function book(issues = {}) {
  return { issue: (k) => issues[k] ?? null }
}

const issue = (n, extra = {}) => ({
  number: n,
  title: `#${n}`,
  labels: [],
  assignees: [],
  createdAt: "2026-11-01T00:00:00Z",
  ...extra,
})

test("labelIds 走服务端过滤后，不再拿 labels 名字做二次过滤", () => {
  // opencli 列表接口不回 labels；配了 labelIds 时若仍按名字筛，会一条都捞不到。
  const c = cfg({ pickup: { labelIds: [5], labels: ["ready-for-agent"] } })
  const list = [issue(255), issue(256)]
  assert.equal(eligible(list, repoCfg, c, book()).length, 2)
})

test("没配 labelIds 时才按 labels 名字 AND 过滤", () => {
  const c = cfg({ pickup: { labels: ["ready-for-agent"] } })
  assert.equal(eligible([issue(1, { labels: ["ready-for-agent"] })], repoCfg, c, book()).length, 1)
  assert.equal(eligible([issue(2, { labels: [] })], repoCfg, c, book()).length, 0)
})

test("excludeLabels 命中即跳过，大小写不敏感", () => {
  const c = cfg()
  const out = eligible([issue(1, { labels: ["Needs-Human"] })], repoCfg, c, book())
  assert.equal(out.length, 0)
})

test("onlyUnassigned 时已指派的单跳过", () => {
  const c = cfg()
  assert.equal(eligible([issue(1, { assignees: ["teng"] })], repoCfg, c, book()).length, 0)
  const off = cfg({ pickup: { onlyUnassigned: false } })
  assert.equal(eligible([issue(1, { assignees: ["teng"] })], repoCfg, off, book()).length, 1)
})

test("已处理过（CLOSED_STATES）的单不再捞", () => {
  const c = cfg()
  const b = book({ "yyzl/win-ai-harness#1": { state: "pr-open" } })
  assert.equal(eligible([issue(1)], repoCfg, c, b).length, 0)
  for (const s of CLOSED_STATES) {
    const bb = book({ "yyzl/win-ai-harness#2": { state: s } })
    assert.equal(eligible([issue(2)], repoCfg, c, bb).length, 0, `${s} 不该再被捞`)
  }
})

test("在飞（working 无 lastFailure）的单不再捞，续跑交给编排/retry；派单失败且没到上限的还能自动重试", () => {
  const c = cfg()
  const inflight = book({ "yyzl/win-ai-harness#1": { state: "working", attempts: 1, lastFailure: "" } })
  assert.equal(eligible([issue(1)], repoCfg, c, inflight).length, 0, "在跑的单每轮都捞会重复发「继续处理」")
  const capped = book({ "yyzl/win-ai-harness#1": { state: "working", attempts: 3, lastFailure: "上次没跑通" } })
  assert.equal(eligible([issue(1)], repoCfg, c, capped).length, 0)
  const dispatchFailed = book({ "yyzl/win-ai-harness#1": { state: "working", attempts: 1, lastFailure: "上次没跑通" } })
  assert.equal(eligible([issue(1)], repoCfg, c, dispatchFailed).length, 1)
  const retried = book({ "yyzl/win-ai-harness#1": { state: "planned", attempts: 2 } })
  assert.equal(eligible([issue(1)], repoCfg, c, retried).length, 1, "retry 放回队列的要能再接")
})

test("排序：默认最老先接，newest 反过来", () => {
  const a = issue(1, { createdAt: "2026-11-01T00:00:00Z" })
  const b = issue(2, { createdAt: "2026-11-05T00:00:00Z" })
  assert.deepEqual(sortIssues([b, a], "oldest").map((x) => x.number), [1, 2])
  assert.deepEqual(sortIssues([a, b], "newest").map((x) => x.number), [2, 1])
})

test("三档优先级：我的（作者是 233151）→ 无人认领 → 他人，同档按最老先接", () => {
  const me = "233151"
  const mine = issue(10, { author: "233151", createdAt: "2026-11-09T00:00:00Z" })
  const free = issue(20, { author: "zhangsan", createdAt: "2026-11-01T00:00:00Z" })
  const other = issue(30, { author: "lisi", assignees: ["wangwu"], createdAt: "2026-10-01T00:00:00Z" })
  const out = sortIssues([other, free, mine], "oldest", { me, priority: ["mine", "unassigned", "others"] })
  assert.deepEqual(out.map((x) => x.number), [10, 20, 30])

  // 换成无人认领优先，顺序跟着变；同类内仍是最老先接
  const freeOld = issue(21, { author: "zhangsan", createdAt: "2026-10-20T00:00:00Z" })
  const out2 = sortIssues([mine, free, freeOld], "oldest", { me, priority: ["unassigned", "mine", "others"] })
  assert.deepEqual(out2.map((x) => x.number), [21, 20, 10])
})

test("onlyUnassigned: false 时，别人的单也进候选（排最后一档）", () => {
  const c = cfg({ pickup: { onlyUnassigned: false, me: "233151", priority: ["mine", "unassigned", "others"] } })
  const pool = sortIssues(eligible([
    issue(1, { author: "233151" }),
    issue(2, { author: "zhangsan" }),
    issue(3, { author: "lisi", assignees: ["wangwu"] }),
  ], repoCfg, c, book()), c.pickup.order, { me: c.pickup.me, priority: c.pickup.priority })
  assert.deepEqual(pool.map((x) => x.number), [1, 2, 3])
})

// ---- 服务侧自动巡检（pickup.auto）：到点自己捞单，不用外部 cron ----

function pickupCtx(cfgOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-pickup-auto-"))
  const logs = []
  return {
    logs,
    ctx: {
      cfg: {
        stateFile: path.join(dir, "state.json"),
        pickup: { auto: true, intervalSeconds: 1800, maxPerRound: 1 },
        workHours: { enabled: false },
        repos: [],
        ...cfgOver,
      },
      log: (m) => logs.push(m),
      state: { pickup: { lastAt: null, count: 0, lastResult: null, running: false } },
      dws: {},
    },
  }
}

test("自动巡检：没开 pickup.auto 就不动作", async () => {
  const { ctx, logs } = pickupCtx({ pickup: { auto: false, intervalSeconds: 1800, maxPerRound: 1 } })
  let called = 0
  const r = await pickupOnce(ctx, { run: async () => { called++; return [] } })
  assert.equal(r.skipped, "disabled")
  assert.equal(called, 0)
  assert.equal(logs.length, 0)
})

test("自动巡检：出了工作时间窗不捞单", async () => {
  // 窗口钉在 00:00–00:01，正常时刻都在窗外（跨零点跑测试时最多命中那一分钟，跳过断言）。
  const { ctx } = pickupCtx({ workHours: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "00:01" } })
  let called = 0
  const r = await pickupOnce(ctx, { run: async () => { called++; return [] } })
  const now = new Date()
  if (now.getHours() === 0 && now.getMinutes() === 0) return
  assert.equal(r.skipped, "off-hours")
  assert.equal(called, 0)
})

test("自动巡检：上一轮没跑完不重入", async () => {
  const { ctx } = pickupCtx()
  ctx.state.pickup.running = true
  let called = 0
  const r = await pickupOnce(ctx, { run: async () => { called++; return [] } })
  assert.equal(r.skipped, "busy")
  assert.equal(called, 0)
})

test("自动巡检：命令行那轮占着 run.lock 就跳过（同一条单不派两次）", async () => {
  const { ctx } = pickupCtx()
  const lockFile = path.join(path.dirname(ctx.cfg.stateFile), "run.lock")
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  let called = 0
  const r = await pickupOnce(ctx, { run: async () => { called++; return [] } })
  assert.equal(r.skipped, "locked")
  assert.equal(called, 0)
})

test("自动巡检：派出一条就记账、写日志，结束后释放锁", async () => {
  const { ctx, logs } = pickupCtx()
  const runCalls = []
  const r = await pickupOnce(ctx, {
    run: async (runCtx) => {
      runCalls.push(runCtx)
      return [{ repo: "yyzl/win-ai-harness", number: 268, state: "dispatched", branch: "fix/issue-268", convId: "1" }]
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.dispatched, 1)
  assert.equal(ctx.state.pickup.count, 1)
  assert.ok(ctx.state.pickup.lastAt)
  assert.deepEqual(ctx.state.pickup.lastResult.handled, ["yyzl/win-ai-harness#268:dispatched"])
  const businessLogs = logs.filter((s) => !s.startsWith("[操作]"))
  assert.equal(businessLogs.length, 1)
  assert.match(businessLogs[0], /自动巡检：/)
  assert.ok(logs.some((s) => s.includes("[操作] 正在巡检并派单")))
  // 每轮最多 maxPerRound 条，靠 ctx.maxTotal 交给 runRound；不带 once（每个仓库都要看）。
  assert.equal(runCalls[0].maxTotal, 1)
  assert.equal(runCalls[0].once, undefined)
  assert.equal(fs.existsSync(path.join(path.dirname(ctx.cfg.stateFile), "run.lock")), false)
  assert.equal(ctx.state.pickup.running, false)
})

test("自动巡检：队列空了只写一句话，不记派单", async () => {
  const { ctx, logs } = pickupCtx()
  const r = await pickupOnce(ctx, { run: async () => [] })
  assert.equal(r.dispatched, 0)
  assert.equal(ctx.state.pickup.count, 1)
  assert.match(logs.find((s) => !s.startsWith("[操作]")), /没有可接的活/)
})

test("自动巡检：开启 pauseWhileRunning 时，有被监听会话还在跑就不开新会话（豆包单实例）", async () => {
  const { ctx, logs } = pickupCtx({ pickup: { auto: true, intervalSeconds: 1800, maxPerRound: 2, pauseWhileRunning: true } })
  ctx.state.watchers = new Map([["conv-running", { target: "conv-running" }]])
  ctx.dws = { runningMap: async () => ({ "conv-running": { running: true } }) }
  let called = 0
  const r = await pickupOnce(ctx, { run: async () => { called++; return [] } })
  assert.equal(r.skipped, "window-busy")
  assert.deepEqual(r.busy, ["conv-running"])
  assert.equal(called, 0)
  assert.match(logs[0], /还在跑，本轮不派新会话/)
})

test("自动巡检：默认不因窗口在跑就停派，空两个槽就一轮补两条", async () => {
  const { ctx } = pickupCtx({ pickup: { auto: true, intervalSeconds: 1800, maxPerRound: 2, maxRunning: 2 } })
  ctx.state.watchers = new Map([["conv-running", { target: "conv-running" }]])
  ctx.dws = { runningMap: async () => ({ "conv-running": { running: true } }) }
  let maxTotal = 0
  const r = await pickupOnce(ctx, { run: async (c) => { maxTotal = c.maxTotal; return [] } })
  assert.equal(r.ok, true)
  assert.notEqual(r.skipped, "window-busy")
  assert.equal(maxTotal, 2)
})

test("自动巡检：在跑到上限就不再捞新单（派单通道容量）", async () => {
  const { ctx } = pickupCtx({ pickup: { auto: true, intervalSeconds: 1800, maxPerRound: 2, maxRunning: 2 } })
  const book = new Book(ctx.cfg.stateFile)
  book.setIssue("yyzl/win-ai-harness#1", { state: "working" })
  book.setIssue("yyzl/win-ai-harness#2", { state: "working" })
  let called = 0
  const r = await pickupOnce(ctx, { run: async () => { called++; return [] } })
  assert.equal(r.skipped, "slots-full")
  assert.equal(r.running, 2)
  assert.equal(called, 0, "两张单在跑就到顶，不再派")
})

test("自动巡检：只剩一个槽就只补一条；派单失败待重试的不占槽", async () => {
  const { ctx } = pickupCtx({ pickup: { auto: true, intervalSeconds: 1800, maxPerRound: 2, maxRunning: 2 } })
  new Book(ctx.cfg.stateFile).setIssue("yyzl/win-ai-harness#1", { state: "working" })
  let maxTotal = 0
  const r = await pickupOnce(ctx, { run: async (c) => { maxTotal = c.maxTotal; return [] } })
  assert.equal(r.ok, true)
  assert.equal(maxTotal, 1)

  const msgs = []
  const r2 = await pickupOnce(ctx, {
    run: async (c) => {
      msgs.push(c.maxTotal)
      return []
    },
  })
  assert.equal(r2.ok, true)
  assert.equal(msgs[0], 1)

  // 把这一条打成「派单失败待重试」：不占槽，容量回到 2。
  new Book(ctx.cfg.stateFile).setIssue("yyzl/win-ai-harness#1", { state: "working", lastFailure: "会话没跑通" })
  let cap = 0
  await pickupOnce(ctx, { run: async (c) => { cap = c.maxTotal; return [] } })
  assert.equal(cap, 2)
})

test("自动巡检：侧边栏读不到不拦派单（dws open 自己有兜底）", async () => {
  const { ctx } = pickupCtx()
  ctx.state.watchers = new Map([["conv-x", { target: "conv-x" }]])
  ctx.dws = { runningMap: async () => { throw new Error("list 失败") } }
  const r = await pickupOnce(ctx, { run: async () => [] })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, undefined)
})
