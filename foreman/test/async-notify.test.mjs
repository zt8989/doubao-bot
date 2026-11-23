import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runRound } from "../src/orchestrator.mjs"
import { startServer, pingOnce, fingerprintOf, judgePoll } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-async-"))
}

function mkCfg(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    worktreeDir: path.join(dir, "worktrees"),
    pollSeconds: 20,
    timeoutMinutes: 90,
    maxAttempts: 3,
    perRepoPerRound: 2,
    pickup: { labelIds: [1], labels: [], excludeLabels: [], onlyUnassigned: false, order: "oldest" },
    herdr: { bin: "herdr", enabled: false },
    merge: { enabled: false },
    notify: { enabled: true, session: "boss", events: ["done", "needs-human", "blocked", "failed"] },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    repos: [
      {
        name: "demo",
        repo: "demo/demo",
        dir: path.join(dir, "repo"),
        base: "dev",
        verify: [],
        labels: null,
      },
    ],
    ...over,
  }
}

// 预置一个伪 worktree 目录 + 一个伪 repo，让 createWorktree 走 reused 分支，不碰真实 git。
function preseedWorktree(cfg) {
  const repoDir = cfg.repos[0].dir
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(repoDir, ".git"), "gitdir: .\n")
  const wt = path.join(cfg.worktreeDir, "demo", "fix-issue-1")
  fs.mkdirSync(wt, { recursive: true })
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: .\n")
  return wt
}

function fakeGitea() {
  return {
    listIssues: async () => [
      { number: 1, title: "测试单", labels: [], assignees: [], createdAt: "2026-11-01T00:00:00Z", url: "" },
    ],
    viewIssue: async (repo, n) => ({ number: n, title: "测试单", body: "", labels: [], assignees: [], url: "" }),
    commentIssue: async () => ({}),
    editLabels: async () => ({}),
  }
}

// ---- 同步路径不存在 ----

test("runRound：派单改投 router（routeIssue），不开会话、不登记 watch", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    const routed = []
    const dws = {
      open: async () => { throw new Error("不应直接开会话") },
      send: async () => { throw new Error("不应直接开会话") },
      notify: async () => { throw new Error("不应直接开会话") },
      waitFinished: async () => { throw new Error("不应 waitFinished") },
      status: async () => ({}),
      info: async () => ({ lastReply: "" }),
    }
    const ctx = {
      cfg,
      book,
      dws,
      log: () => {},
      gitea: fakeGitea(),
      once: true,
      dryRun: false,
      routeIssue: async ({ repoCfg, issue }) => {
        routed.push({ repo: repoCfg.repo, number: issue.number })
        return { ok: true, state: "handed", routed: "router", key: `${repoCfg.repo}#${issue.number}` }
      },
    }
    const out = await runRound(ctx)
    assert.equal(out.length, 1)
    assert.equal(out[0].state, "handed")
    assert.equal(out[0].routed, "router")
    assert.deepEqual(routed, [{ repo: "demo/demo", number: 1 }])
    assert.equal(book.watch.length, 0, "派单不再登记外部工作会话监听")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runRound：routeIssue 抛错记为 failed，不炸整轮", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    const ctx = {
      cfg,
      book,
      dws: {},
      log: () => {},
      gitea: fakeGitea(),
      once: true,
      dryRun: false,
      routeIssue: async () => { throw new Error("inbox 暂不可用") },
    }
    const out = await runRound(ctx)
    assert.equal(out.length, 1)
    assert.equal(out[0].state, "failed")
    assert.match(out[0].reason, /inbox 暂不可用/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 端到端异步 ----

test("端到端：状态经 Inbox/Worker 投递，同指纹与重启都不重复", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    // 先登记一条 watch
    book.setWatch({ target: "conv-e2e", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })

    // 假 dws：status 队列控制行为；notify 记调用。
    const statusQueue = [
      // 第二轮：跑完，指纹变了
      { name: "conv-e2e", streaming: false, finished: true, chars: 500, head: "H2", tail: "T2", status: "ok" },
      // 第三轮：同指纹（重跑不发）
      { name: "conv-e2e", streaming: false, finished: true, chars: 500, head: "H2", tail: "T2", status: "ok" },
    ]
    const notified = []
    let sidebarRunning = true
    const dws = {
      runningMap: async () => ({ "conv-e2e": { running: sidebarRunning } }),
      status: async () => statusQueue.shift() ?? { name: "conv-e2e", streaming: false, finished: true, chars: 500, head: "H2", tail: "T2", status: "ok" },
      info: async () => ({ lastReply: "做完了，已提交并通过测试。" }),
      queue: async (target, text) => { notified.push({ target, text }) },
      notify: async () => { throw new Error("旧 notify 不应参与任务状态投递") },
    }

    server = await startServer({ cfg, book, dws, log: () => {} })

    const drain = async () => { await server.worker.idle(); await server.worker.runOnce() }
    // 第一轮 running：只落本地账本，不入箱、不投递编排
    let r = await server.poll()
    assert.equal(r.checked, 1)
    assert.equal(r.settled, 0)
    assert.equal(r.notified, 0)
    await drain()
    assert.equal(notified.length, 0, JSON.stringify({ r, events: server.inbox.list(), worker: server.worker.lastResult }))
    assert.equal(server.inbox.list({ status: "pending" }).length, 0, "running 不产生 task.update")
    assert.equal(new Book(cfg.stateFile).notified["conv-e2e"]?.observedPhase, "running")
    sidebarRunning = false

    // 第二轮 finished + 指纹变化 → 先入箱，Worker 才投递并消费指纹
    r = await server.poll()
    assert.equal(r.settled, 1)
    assert.equal(r.notified, 0)
    await drain()
    assert.equal(notified.length, 1)
    assert.match(notified[0].text, /做完了，已提交并通过测试。/)
    const led = new Book(cfg.stateFile).notified["conv-e2e"]
    assert.match(led.fingerprint, /^[0-9a-f]{12}$/)

    // 第三轮同指纹 → 不再入箱或投递
    r = await server.poll()
    assert.equal(r.enqueued ?? 0, 0)
    await drain()
    assert.equal(notified.length, 1)

    // 关闭服务（模拟重启）
    await server.close()
    server = null

    // 新起一个服务（新进程状态），但 notified 已持久化
    const server2 = await startServer({ cfg, book: new Book(cfg.stateFile), dws, log: () => {} })
    try {
      r = await server2.poll()
      assert.equal(r.notified, 0, "重启后不重发")
      await server2.worker.idle()
      assert.equal(notified.length, 1)
      await server2.close()
    } catch (e) {
      await server2.close()
      throw e
    }

    // 验证 notified 持久化
    const book2 = new Book(cfg.stateFile)
    assert.ok(book2.notified["conv-e2e"])
    assert.match(book2.notified["conv-e2e"].fingerprint, /^[0-9a-f]{12}$/)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("notify 抛错 → dwsErrors 计数 + 不崩", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-fail", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    const dws = {
      runningMap: async () => ({ "conv-fail": { running: false } }),
      status: async () => ({ name: "conv-fail", streaming: false, finished: true, chars: 100, head: "H", tail: "T", status: "ok" }),
      info: async () => ({ lastReply: "" }),
      notify: async () => {
        throw new Error("smtp down")
      },
    }
    server = await startServer({ cfg, book, dws, log: () => {} })
    const r = await server.poll()
    // notify 失败：notified 不计数，但 poll 不崩
    assert.equal(r.checked, 1)
    assert.equal(r.notified, 0)
    // 查服务状态：dwsErrors >= 1
    const s = await pingOnce(server.port, 2000)
    assert.ok(s.watchers >= 1)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 旧 notify 开关不再吞掉 task.update；Worker 成功 queue 后，同一指纹只消费一次。
test("任务状态只经 queue：首轮投递后，后续同指纹不重复", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir, { notify: { enabled: true, session: "boss", maxAttempts: 2, events: ["done"] } })
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-ghost", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    const sent = []
    const dws = {
      runningMap: async () => ({ "conv-ghost": { running: false } }),
      status: async () => ({ name: "conv-ghost", streaming: false, finished: true, chars: 100, head: "H", tail: "T", status: "ok" }),
      info: async () => ({ lastReply: "做完了，已提交并通过测试。" }),
      queue: async (target, text) => { sent.push({ target, text }) },
      notify: async () => { throw new Error("旧 notify 不应参与任务状态投递") },
    }
    server = await startServer({ cfg, book, dws, log: () => {} })
    await server.poll()
    await server.worker.idle()
    await server.worker.runOnce()
    assert.equal(sent.length, 1)
    for (let i = 0; i < 4; i++) {
      const r = await server.poll()
      assert.equal(r.enqueued ?? 0, 0)
    }
    assert.equal(sent.length, 1, "同一指纹不重复 queue")
    const led = new Book(cfg.stateFile).notified["conv-ghost"]
    assert.match(led.fingerprint, /^[0-9a-f]{12}$/)
    assert.equal(led.attempts ?? 0, 0)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("judgePoll：同指纹有失败账时按 maxAttempts 决定是否重试", () => {
  const status = { name: "c", streaming: false, finished: true, chars: 9, head: "H", tail: "T", status: "ok" }
  const fp = fingerprintOf(status)
  // 没传 maxAttempts：老口径，同指纹不发
  assert.equal(judgePoll({ fingerprint: fp }, status).shouldNotify, false)
  // 传了：attempts=1 < 2 允许再试；attempts=2 用完就停
  assert.equal(judgePoll({ fingerprint: fp, attempts: 1 }, status, { maxAttempts: 2 }).shouldNotify, true)
  assert.equal(judgePoll({ fingerprint: fp, attempts: 2 }, status, { maxAttempts: 2 }).shouldNotify, false)
  // 指纹变了照常发
  assert.equal(judgePoll({ fingerprint: "deadbeef0000", attempts: 2 }, status, { maxAttempts: 2 }).shouldNotify, true)
})
