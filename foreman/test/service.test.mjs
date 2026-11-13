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
} from "../src/service.mjs"
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

test("notifyDecision：无 RESULT 时正文带执行会话 id 与最后回复；有 RESULT 不贴原文", () => {
  const cfg = { notify: { enabled: true, session: "boss", events: ["done", "failed"] }, deliver: { mode: "new" } }
  const watcher = { target: "conv-1", name: "开工", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" }
  const book = { issue: () => ({ title: "统一路由", branch: "fix/issue-1" }) }
  const none = notifyDecision({ cfg, watcher, book, env: {}, result: { status: "none", text: "最后一句：卡在依赖安装" } })
  assert.match(none.text, /执行会话：conv-1（开工）/)
  assert.match(none.text, /没有检测到 RESULT/)
  assert.match(none.text, /最后一句：卡在依赖安装/)
  const done = notifyDecision({ cfg, watcher, book, env: {}, result: { status: "done", pr: 3, prUrl: "http://x/3", summary: "ok", text: "原文不该出现" } })
  assert.match(done.text, /执行会话：conv-1/)
  assert.ok(!done.text.includes("没有检测到 RESULT"))
  assert.ok(!done.text.includes("原文不该出现"))
})

// 服务级 ctx 不带账本（只有 state/cfg/dws/engine），dispatch 这条 RPC 必须自己兜底开 Book，
// 否则 handleIssue 一进来读 book.issue(key) 就崩：Cannot read properties of undefined (reading 'issue')。
test("dispatch RPC：ctx 不带 book 也能派（dry-run 走完不崩在 book.issue）", async () => {
  const dir = tmpDir()
  try {
    const repo = { repo: "yyzl/demo", name: "demo", dir, base: "sit-20261126", product: "demo" }
    const cfg = mkCfg(dir, { worktreeDir: path.join(dir, "worktrees"), repos: [repo], sessionFlow: { enabled: true } })
    const ctx = {
      ...mkCtx(cfg),
      dryRun: true,
      gitea: { viewIssue: async (repoArg, n) => ({ number: n, title: "登录改造", body: "", labels: [], assignees: [], url: "" }) },
    }
    assert.equal(ctx.book, undefined, "这条 RPC 的 ctx 就是服务级 ctx，本身没有 book")
    const r = await handleRequest(ctx, { id: "t", cmd: "dispatch", issue: "yyzl/demo#7" })
    assert.equal(r.ok, true)
    assert.equal(r.state, "planned")
    assert.equal(r.workspaces.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
