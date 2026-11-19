import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  encodeFrame,
  decodeFrame,
  MAX_FRAME_BYTES,
  fingerprintOf,
  phaseOf,
  judgePoll,
  watchersFor,
  notifyDecision,
  handleRequest,
  archiveFinishedOrchestrators,
  kickPickup,
} from "../src/service.mjs"
import { sleep } from "../src/util.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-svc-"))
}

function mkCfg(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    pollSeconds: 20,
    notify: { enabled: true, session: "auto", events: ["done", "needs-human", "blocked", "failed"] },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
    },
    ...over,
  }
}

function mkCtx(cfg, extra = {}) {
  return {
    cfg,
    state: {
      pid: 12345,
      version: "0.1.0",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      pollSeconds: cfg.pollSeconds,
      watchers: new Map(extra.watchers ?? []),
      lastPollAt: null,
      pollCount: 0,
      notifiedCount: 0,
      dwsErrors: 0,
    },
    dws: extra.dws ?? {},
    log: () => {},
    poll: extra.poll ?? (async () => ({ checked: 0, settled: 0, notified: 0 })),
    close: async () => {},
  }
}

// ---- 帧编解码 ----

test("encodeFrame/decodeFrame 中文与嵌套对象往返", () => {
  const obj = { id: "a", cmd: "ping", data: { 中文: "你好", list: [1, 2, { x: true }] } }
  const line = encodeFrame(obj)
  assert.ok(line.endsWith("\n"))
  assert.deepEqual(decodeFrame(line.trim()), obj)
})

test("decodeFrame 空行抛错", () => {
  assert.throws(() => decodeFrame(""), /空帧/)
  assert.throws(() => decodeFrame("   \n  "), /空帧/)
})

test("decodeFrame 非法 JSON 抛错并带截断原文", () => {
  const junk = "{not json" + "x".repeat(300)
  assert.throws(() => decodeFrame(junk), /坏 JSON/)
})

test("MAX_FRAME_BYTES = 1MiB", () => {
  assert.equal(MAX_FRAME_BYTES, 1 << 20)
})

// ---- phaseOf / fingerprintOf / judgePoll ----

test("phaseOf：streaming/finished/settled/pending/unknown 五态", () => {
  assert.equal(phaseOf({ streaming: true, finished: false, chars: 100, status: "" }), "running")
  assert.equal(phaseOf({ streaming: false, finished: true, chars: 100, status: "ok" }), "finished")
  assert.equal(phaseOf({ streaming: false, finished: false, chars: 500, status: "ended" }), "settled")
  assert.equal(phaseOf({ streaming: false, finished: false, chars: 0, status: "" }), "pending")
  assert.equal(phaseOf({}), "pending")
  assert.equal(phaseOf(null), "unknown")
  assert.equal(phaseOf(undefined), "unknown")
})

test("fingerprintOf：不同内容不同指纹；缺字段按空串", () => {
  const a = fingerprintOf({ chars: 100, head: "hello", tail: "world" })
  const b = fingerprintOf({ chars: 100, head: "hello", tail: "world" })
  const c = fingerprintOf({ chars: 101, head: "hello", tail: "world" })
  const d = fingerprintOf({})
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.match(d, /^[0-9a-f]{12}$/)
})

test("judgePoll：running 不发；finished+新指纹发；同指纹不发；还没开始不动", () => {
  const running = { streaming: true, finished: false, chars: 10, status: "go" }
  assert.equal(judgePoll({}, running).shouldNotify, false)

  const fin = { streaming: false, finished: true, chars: 200, head: "H", tail: "T" }
  const r1 = judgePoll({}, fin)
  assert.equal(r1.phase, "finished")
  assert.equal(r1.shouldNotify, true)

  const r2 = judgePoll({ fingerprint: r1.fingerprint }, fin)
  assert.equal(r2.shouldNotify, false)

  const pending = { streaming: false, finished: false, chars: 0, status: "" }
  assert.equal(judgePoll({}, pending).shouldNotify, false)
  assert.equal(judgePoll({}, pending).phase, "pending")
})

// ---- watchersFor ----

test("watchersFor：显式优先；sessions 里 notify!==false 且有 convId 纳入", () => {
  const dir = tmpDir()
  try {
    const book = new Book(path.join(dir, "state.json"))
    book.setWatch({ target: "conv-A", name: "watcher-A", issueKey: "r#1", repo: "r", number: 1, notifyTo: "boss" })
    book.record("session-x", { convId: "conv-B", issue: 2 })
    book.record("session-y", { convId: "conv-C", issue: 3, notify: false })
    book.record("session-z", { issue: 4 }) // 没 convId
    const list = watchersFor(book, {})
    const targets = list.map((w) => w.target)
    assert.ok(targets.includes("conv-A"))
    assert.ok(targets.includes("conv-B"))
    assert.ok(!targets.includes("conv-C"))
    assert.ok(!targets.includes("conv-Z"))
    const a = list.find((w) => w.target === "conv-A")
    assert.equal(a.source, "watch")
    assert.equal(a.notifyTo, "boss")
    const b = list.find((w) => w.target === "conv-B")
    assert.equal(b.source, "session")
    assert.equal(b.number, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- notifyDecision ----

test("notifyDecision：auto 取 env.MCP_VM_CONVERSATION_ID；notifyTo 覆盖；目标是自己不发；无目标不发；disabled 不发", () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const env = { MCP_VM_CONVERSATION_ID: "boss-conv" }
    const w = { target: "conv-A", name: "worker-A", issueKey: "r#1", repo: "r", number: 1, notifyTo: "" }

    // auto → env
    let d = notifyDecision({ cfg, watcher: w, book: { issue: () => ({}) }, env, result: { status: "done" } })
    assert.equal(d.send, true)
    assert.equal(d.target, "boss-conv")
    assert.equal(d.event, "done")

    // notifyTo 覆盖
    const w2 = { ...w, notifyTo: "override-target" }
    d = notifyDecision({ cfg, watcher: w2, book: { issue: () => ({}) }, env, result: { status: "done" } })
    assert.equal(d.send, true)
    assert.equal(d.target, "override-target")

    // 目标是被监听会话自己 → self
    const w3 = { ...w, notifyTo: "conv-A" }
    d = notifyDecision({ cfg, watcher: w3, book: { issue: () => ({}) }, env, result: { status: "done" } })
    assert.equal(d.send, false)
    assert.equal(d.reason, "self")

    // 无目标（env 也没有）
    d = notifyDecision({ cfg, watcher: w, book: { issue: () => ({}) }, env: {}, result: { status: "done" } })
    assert.equal(d.send, false)
    assert.equal(d.reason, "no-target")

    // disabled
    const cfgOff = { ...cfg, notify: { ...cfg.notify, enabled: false } }
    d = notifyDecision({ cfg: cfgOff, watcher: w, book: { issue: () => ({}) }, env, result: { status: "done" } })
    assert.equal(d.send, false)
    assert.equal(d.reason, "disabled")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("notifyDecision：event-filtered 拦截；session-done 不过滤", () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { notify: { enabled: true, session: "boss", events: ["done"] } })
    const w = { target: "conv-A", name: "w", issueKey: "r#1", repo: "r", number: 1, notifyTo: "boss" }

    // blocked 不在 events 里 → event-filtered
    let d = notifyDecision({ cfg, watcher: w, book: { issue: () => ({}) }, env: {}, result: { status: "blocked" } })
    assert.equal(d.send, false)
    assert.equal(d.reason, "event-filtered")

    // done 在 events 里 → send
    d = notifyDecision({ cfg, watcher: w, book: { issue: () => ({}) }, env: {}, result: { status: "done" } })
    assert.equal(d.send, true)

    // session-done（无 result）不过滤，即使 events 不含
    d = notifyDecision({ cfg, watcher: w, book: { issue: () => ({}) }, env: {}, result: null })
    assert.equal(d.send, true)
    assert.equal(d.event, "session-done")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- handleRequest ----

test("handleRequest：ping/status/unknown_cmd/bad_request", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const ctx = mkCtx(cfg)

    let r = await handleRequest(ctx, { id: "1", cmd: "ping" })
    assert.equal(r.ok, true)
    assert.equal(r.pid, process.pid)
    assert.equal(r.watchers, 0)

    r = await handleRequest(ctx, { id: "2", cmd: "status" })
    assert.equal(r.ok, true)
    assert.equal(r.pollCount, 0)

    r = await handleRequest(ctx, { id: "3", cmd: "nope" })
    assert.equal(r.ok, false)
    assert.equal(r.error, "unknown_cmd")

    r = await handleRequest(ctx, { id: "4", cmd: "watch add" })
    assert.equal(r.ok, false)
    assert.equal(r.error, "bad_request")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("handleRequest：watch add/list/remove 落地到 book", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const ctx = mkCtx(cfg)

    let r = await handleRequest(ctx, { id: "1", cmd: "watch add", target: "conv-X", repo: "r", number: 7, notifyTo: "boss" })
    assert.equal(r.ok, true)
    assert.equal(r.watcher.target, "conv-X")
    assert.equal(r.watcher.repo, "r")
    assert.equal(r.watcher.issueKey, "r#7", "repo+number 要推出 issueKey，否则工单状态与关单都不会推进")

    r = await handleRequest(ctx, { id: "2", cmd: "watch list" })
    assert.equal(r.ok, true)
    assert.equal(r.watchers.length, 1)
    assert.equal(r.watchers[0].target, "conv-X")

    // book 里也真的落了
    const book = new Book(cfg.stateFile)
    assert.equal(book.watch.length, 1)
    assert.equal(book.watch[0].target, "conv-X")

    r = await handleRequest(ctx, { id: "3", cmd: "watch remove", target: "conv-X" })
    assert.equal(r.ok, true)
    assert.equal(r.removed, true)

    r = await handleRequest(ctx, { id: "4", cmd: "watch list" })
    assert.equal(r.watchers.length, 0)
    assert.equal(new Book(cfg.stateFile).watch.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("handleRequest：poll 走注入的 poll 函数；stop 返回 stopping", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    let polled = 0
    const ctx = mkCtx(cfg, { poll: async () => ({ checked: 1, settled: 1, notified: 1 }) })
    ctx.poll = async () => {
      polled++
      return { checked: 1, settled: 1, notified: 1 }
    }
    const r = await handleRequest(ctx, { id: "1", cmd: "poll" })
    assert.equal(r.ok, true)
    assert.equal(r.checked, 1)
    assert.equal(polled, 1)

    const s = await handleRequest(ctx, { id: "2", cmd: "stop" })
    assert.equal(s.ok, true)
    assert.equal(s.stopping, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("notifyDecision：无 RESULT 按 session-done 通知并带最后回复；有 RESULT 不贴原文", () => {
  const cfg = { notify: { enabled: true, session: "boss", events: ["done", "failed"] }, deliver: { mode: "new" } }
  const watcher = { target: "conv-1", name: "开工", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" }
  const book = { issue: () => ({ title: "统一路由", branch: "fix/issue-1" }) }
  const none = notifyDecision({ cfg, watcher, book, env: {}, result: { status: "none", text: "最后一句：卡在依赖安装" } })
  assert.equal(none.event, "session-done")
  assert.equal(none.send, true)
  assert.match(none.text, /状态：session-done/)
  assert.doesNotMatch(none.text, /状态：failed/)
  assert.match(none.text, /执行会话：conv-1（开工）/)
  assert.match(none.text, /没有检测到 RESULT/)
  assert.match(none.text, /最后一句：卡在依赖安装/)
  const done = notifyDecision({ cfg, watcher, book, env: {}, result: { status: "done", pr: 3, prUrl: "http://x/3", summary: "ok", text: "原文不该出现" } })
  assert.match(done.text, /执行会话：conv-1/)
  assert.ok(!done.text.includes("没有检测到 RESULT"))
  assert.ok(!done.text.includes("原文不该出现"))
})

test("sessions RPC：只列当前编排会话派出的工作/补派会话并去重", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("demo/demo#1", {
      state: "working", agent: "worker-1", agentConvId: "conv-worker-1", orchestrator: "conv-current",
    })
    book.record("worker-1", { convId: "conv-worker-1", kind: "worker", parent: "conv-current" })
    book.setIssue("demo/demo#2", {
      state: "working", agent: "worker-2", agentConvId: "conv-worker-2", orchestrator: "conv-other",
    })
    book.setIssue("demo/demo#3", { state: "working", orchestrator: "conv-current" })
    book.setWatch({ target: "conv-legacy-helper", name: "legacy-helper", issueKey: "demo/demo#3" })
    book.setWatch({ target: "conv-worker-1", name: "worker-1", issueKey: "demo/demo#1", parent: "conv-current" })
    book.setWatch({ target: "conv-other-helper", name: "other-helper", parent: "conv-other" })
    const ctx = mkCtx(cfg)

    const added = await handleRequest(ctx, {
      id: "s0", cmd: "watch add", target: "conv-helper", name: "helper", orchestrator: "conv-current",
    })
    assert.equal(added.ok, true)
    assert.equal(added.watcher.parent, "conv-current")

    const r = await handleRequest(ctx, { id: "s1", cmd: "sessions", orchestrator: "conv-current" })
    assert.equal(r.ok, true)
    assert.equal(r.count, 3)
    assert.deepEqual(r.sessions.map((s) => s.convId).sort(), ["conv-helper", "conv-legacy-helper", "conv-worker-1"])
    assert.deepEqual(r.sessions.find((s) => s.convId === "conv-worker-1").sources, ["dispatch", "watch"])
    assert.equal(r.sessions.find((s) => s.convId === "conv-legacy-helper").issueKey, "demo/demo#3")

    const other = await handleRequest(ctx, { id: "s2", cmd: "sessions", orchestrator: "conv-other" })
    assert.deepEqual(other.sessions.map((s) => s.convId).sort(), ["conv-other-helper", "conv-worker-2"])
    const missing = await handleRequest(ctx, { id: "s3", cmd: "sessions" })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /当前会话 id/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("resume RPC：只收会话 id，并 steer 这条会话而不是按工单续跑", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { repos: [{ repo: "yyzl/demo", base: "sit-20261126" }] })
    new Book(cfg.stateFile).setIssue("yyzl/demo#7", {
      state: "blocked",
      title: "统一路由",
      branch: "fix/issue-7",
      agent: "worker-7",
      agentConvId: "conv-worker-7",
      lastFailure: "缺少依赖工程",
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-7", worktree: "/w/demo" }],
    })
    const steered = []
    const ctx = mkCtx(cfg, { dws: { steer: async (target, text) => steered.push({ target, text }) } })
    const r = await handleRequest(ctx, { id: "r1", cmd: "resume", sessionId: "conv-worker-7" })
    assert.equal(r.ok, true)
    assert.equal(r.issueKey, "yyzl/demo#7")
    assert.equal(steered.length, 1)
    assert.equal(steered[0].target, "conv-worker-7")

    const legacy = await handleRequest(ctx, { id: "r2", cmd: "resume", issue: "yyzl/demo#7" })
    assert.equal(legacy.ok, false)
    assert.match(legacy.message, /foreman resume <执行会话id>/)
    assert.equal(steered.length, 1, "工单号入口不得触发续跑")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 服务级 ctx 不带账本（只有 state/cfg/dws/engine），dispatch 这条 RPC 必须自己兜底开 Book，
// 否则 handleIssue 一进来读 book.issue(key) 就崩：Cannot read properties of undefined (reading 'issue')。
// pickup.maxRunning 只约束定时巡检；即使已经达到上限，agent 主动 dispatch 也必须能派。
test("dispatch RPC：达到定时巡检上限后，agent 仍能派且 ctx 不带 book 也不崩", async () => {
  const dir = tmpDir()
  try {
    const repo = { repo: "yyzl/demo", name: "demo", dir, base: "sit-20261126", product: "demo" }
    const cfg = mkCfg(dir, {
      worktreeDir: path.join(dir, "worktrees"),
      repos: [repo],
      sessionFlow: { enabled: true },
      pickup: { maxRunning: 1, maxPerRound: 1 },
    })
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#1", { state: "working" })
    const ctx = {
      ...mkCtx(cfg),
      dryRun: true,
      gitea: { viewIssue: async (repoArg, n) => ({ number: n, title: "登录改造", body: "", labels: [], assignees: [], url: `http://gitea/yyzl/demo/issues/${n}` }) },
    }
    assert.equal(ctx.book, undefined, "这条 RPC 的 ctx 就是服务级 ctx，本身没有 book")
    const missing = await handleRequest(ctx, { id: "t0", cmd: "dispatch", issue: "yyzl/demo#7" })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /必须提供非空编排指令/)
    const r = await handleRequest(ctx, {
      id: "t", cmd: "dispatch", issue: "yyzl/demo#7",
      prompt: "只负责登录页前端；先复用现有请求封装，完成后跑前端单测。",
    })
    assert.equal(r.ok, true)
    assert.equal(r.state, "planned")
    assert.equal(r.workspaces.length, 1)
    assert.ok(r.prompt.startsWith("【工作会话 · yyzl/demo#7 ·"), "头部必须带完整工单 ID")
    assert.match(r.prompt.split("\n").slice(0, 4).join("\n"), /工单链接：http:\/\/gitea\/yyzl\/demo\/issues\/7/)
    assert.match(r.prompt, /编排智能体补充指令/)
    assert.match(r.prompt, /只负责登录页前端；先复用现有请求封装，完成后跑前端单测。/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 收口工单的编排会话自动归档 ----
// 每张单一条独立编排会话：工单 done 之后它没有下一件事，但早先没人收，侧边栏越积越多。
test("archiveFinishedOrchestrators：收口的单归档自己的编排会话；在跑/pr-open/用户会话/全局编排都不动", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    const rec = (name, issueKey, convId) =>
      book.record(name, { convId, kind: "orchestrator", role: "orchestrator", issueKey, notify: false })

    // 1) done + foreman 建的编排会话 → 收
    book.setIssue("yyzl/demo#1", { state: "done", orchestrator: "conv-o1" })
    rec("foreman-demo-1-编排", "yyzl/demo#1", "conv-o1")
    // 2) done 但编排会话还在跑 → 这轮跳过
    book.setIssue("yyzl/demo#2", { state: "done", orchestrator: "conv-o2" })
    rec("foreman-demo-2-编排", "yyzl/demo#2", "conv-o2")
    // 3) done 但编排是用户自己的会话（账本里没有 orchestrator 记录）→ 不动
    book.setIssue("yyzl/demo#3", { state: "done", orchestrator: "conv-user" })
    // 4) pr-open 还没合完 → 不动
    book.setIssue("yyzl/demo#4", { state: "pr-open", orchestrator: "conv-o4" })
    rec("foreman-demo-4-编排", "yyzl/demo#4", "conv-o4")
    // 5) 全局编排（没有 issueKey）挂了多张单 → 绝不动
    book.setOrchestrator({ convId: "conv-global", name: "foreman-编排" })
    book.record("foreman-编排", { convId: "conv-global", kind: "orchestrator", role: "orchestrator", notify: false })
    book.setIssue("yyzl/demo#5", { state: "done", orchestrator: "conv-global" })

    const archived = []
    const dws = { archive: async (t) => { archived.push(t) } }
    const notes = await archiveFinishedOrchestrators({
      dws,
      stateFile: cfg.stateFile,
      log: () => {},
      sidebar: { "conv-o2": { running: true } },
    })
    assert.deepEqual(archived, ["conv-o1"], "只归档收口且已经停下来的那张单自己的编排会话")
    assert.match(notes.join("；"), /foreman-demo-1-编排 已归档/)
    const after = new Book(cfg.stateFile)
    assert.equal(after.issue("yyzl/demo#1").orchestrator, "")
    assert.equal(after.session("foreman-demo-1-编排"), null)
    assert.equal(after.issue("yyzl/demo#2").orchestrator, "conv-o2", "在跑的先留着")
    assert.equal(after.session("foreman-demo-2-编排")?.convId, "conv-o2")
    assert.equal(after.issue("yyzl/demo#4").orchestrator, "conv-o4", "没合完不动")
    assert.equal(after.session("foreman-编排")?.convId, "conv-global", "全局编排不动")

    // 下一轮：上一条已经停了，这一轮才收它（在跑的那轮本来就不该动）。
    const again = await archiveFinishedOrchestrators({ dws, stateFile: cfg.stateFile, log: () => {} })
    assert.deepEqual(archived, ["conv-o1", "conv-o2"])
    assert.equal(again.length, 1)
    // 第三轮彻底没得收了
    const third = await archiveFinishedOrchestrators({ dws, stateFile: cfg.stateFile, log: () => {} })
    assert.equal(third.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("archiveFinishedOrchestrators：归档真的失败只记账，不推翻工单状态", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#8", { state: "done", orchestrator: "conv-bad" })
    book.record("foreman-demo-8-编排", { convId: "conv-bad", kind: "orchestrator", issueKey: "yyzl/demo#8" })
    const notes = await archiveFinishedOrchestrators({
      dws: { archive: async () => { throw new Error("dws archive 超时") } },
      stateFile: cfg.stateFile,
      log: () => {},
    })
    assert.match(notes.join("；"), /归档失败/)
    const after = new Book(cfg.stateFile)
    assert.equal(after.issue("yyzl/demo#8").state, "done", "工单状态不能被归档失败推翻")
    assert.equal(after.issue("yyzl/demo#8").orchestrator, "conv-bad", "记录留着下一轮再试")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("archiveFinishedOrchestrators：会话已不在侧边栏 → 收掉绑定，不再每轮重试", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#9", { state: "done", orchestrator: "conv-gone" })
    book.record("foreman-demo-9-编排", { convId: "conv-gone", kind: "orchestrator", issueKey: "yyzl/demo#9" })
    const logs = []
    const notes = await archiveFinishedOrchestrators({
      dws: { archive: async () => { throw new Error("侧边栏里没有任务 conv-gone") } },
      stateFile: cfg.stateFile,
      log: (m) => logs.push(m),
    })
    assert.match(notes.join("；"), /已不在侧边栏/)
    assert.doesNotMatch(notes.join("；"), /归档失败/)
    const after = new Book(cfg.stateFile)
    assert.equal(after.issue("yyzl/demo#9").state, "done")
    assert.equal(after.issue("yyzl/demo#9").orchestrator, "", "会话没了就收掉绑定")
    assert.ok(after.issue("yyzl/demo#9").orchestratorArchivedAt, "留收掉的时间")
    assert.equal(after.session("foreman-demo-9-编排"), null)
    // 第二轮没有任何要处理的了
    const again = await archiveFinishedOrchestrators({ dws: { archive: async () => { throw new Error("侧边栏里没有任务") } }, stateFile: cfg.stateFile, log: () => {} })
    assert.equal(again.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 收口后续跑：一张单完成就立刻补下一张，不等自动巡检的 cron ----
test("kickPickup：自动巡检关着 / kickAfterDone=false 时不排", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { pickup: { auto: false } })
    let calls = 0
    const ctx = { cfg, state: { pickup: { running: false } }, log: () => {}, pickup: async () => { calls++ } }
    assert.equal(kickPickup(ctx, "t"), false)
    assert.equal(cfg && kickPickup(ctx, "t"), false)
    const off = mkCfg(dir, { pickup: { auto: true, kickAfterDone: false } })
    assert.equal(kickPickup({ ...ctx, cfg: off }, "t"), false)
    await sleep(20)
    assert.equal(calls, 0, "关掉就不该跑")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("kickPickup：自动巡检开着就补一轮；连着调只排一次（防抖）", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { pickup: { auto: true, kickDelayMs: 5 } })
    const ran = []
    const ctx = { cfg, state: { pickup: { running: false } }, log: () => {}, pickup: async () => { ran.push("x"); return { ok: true, dispatched: 1, handed: 0 } } }
    assert.equal(kickPickup(ctx, "合并关单"), true)
    // 编排随后还会调一次 clean：这一拍不该再排第二轮
    assert.equal(kickPickup(ctx, "clean 收尾"), true)
    await sleep(40)
    assert.equal(ran.length, 1, "同一时刻只排一轮")
    // 定时器清掉后，下一次收口还能再补
    assert.equal(kickPickup(ctx, "下一张"), true)
    await sleep(40)
    assert.equal(ran.length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("kickPickup：巡检正忙时等它收工再补（最多 3 次），不把续跑丢掉", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { pickup: { auto: true, kickDelayMs: 5, kickRetryMs: 5 } })
    const outs = [{ skipped: "busy" }, { skipped: "busy" }, { ok: true, dispatched: 1 }]
    let calls = 0
    const ctx = {
      cfg,
      state: { pickup: { running: false } },
      log: () => {},
      pickup: async () => { const out = outs[calls++]; return out },
    }
    kickPickup(ctx, "合并关单")
    await sleep(60)
    assert.equal(calls, 3, "busy → 重试 → 成功")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("kickPickup：槽位满/下班不算失败，不重试", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, { pickup: { auto: true, kickDelayMs: 5, kickRetryMs: 5 } })
    let calls = 0
    const ctx = { cfg, state: { pickup: { running: false } }, log: () => {}, pickup: async () => { calls++; return { skipped: "slots-full" } } }
    kickPickup(ctx, "合并关单")
    await sleep(40)
    assert.equal(calls, 1, "slots-full 不重试")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
