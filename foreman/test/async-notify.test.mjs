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

test("runRound：派活但不 notify、不 waitFinished；book.watch 有登记；sessions 记了 convId", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    preseedWorktree(cfg)
    const book = new Book(cfg.stateFile)

    const calls = { notify: 0, waitFinished: 0, open: 0, send: 0 }
    const dws = {
      open: async ({ name }) => {
        calls.open++
        return { convId: "conv-dispatch-1" }
      },
      send: async () => {
        calls.send++
      },
      notify: async () => {
        calls.notify++
      },
      waitFinished: async () => {
        calls.waitFinished++
      },
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
    }
    const out = await runRound(ctx)
    assert.equal(out.length, 1)
    assert.equal(out[0].state, "dispatched")
    assert.equal(out[0].convId, "conv-dispatch-1")

    // 同步路径不存在：notify 0 次、waitFinished 0 次。
    assert.equal(calls.notify, 0, "run 不应同步发通知")
    assert.equal(calls.waitFinished, 0, "run 不应 waitFinished")

    // watch 里有一条登记，target=convId
    assert.equal(book.watch.length, 1)
    assert.equal(book.watch[0].target, "conv-dispatch-1")
    assert.equal(book.watch[0].issueKey, "demo/demo#1")

    // sessions 记了 convId
    const sess = book.session("foreman-demo-1")
    assert.ok(sess)
    assert.equal(sess.convId, "conv-dispatch-1")
    assert.equal(sess.notify, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("--no-notify：不登记 watch，sessions 里 notify=false（不被自动纳入）", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    preseedWorktree(cfg)
    const book = new Book(cfg.stateFile)
    const dws = {
      open: async () => ({ convId: "conv-no-notify" }),
      send: async () => {},
      notify: async () => { throw new Error("不应调用 notify") },
      waitFinished: async () => { throw new Error("不应调用 waitFinished") },
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
      noNotify: true,
    }
    const out = await runRound(ctx)
    assert.equal(out[0].state, "dispatched")
    assert.equal(book.watch.length, 0, "--no-notify 时不登记监听")
    const sess = book.session("foreman-demo-1")
    assert.equal(sess.notify, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 端到端异步 ----

test("端到端：poll 驱动 running→finished 恰好发 1 次；同指纹再 poll 0 次；重启后仍 0 次", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    // 先登记一条 watch
    book.setWatch({ target: "conv-e2e", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })

    // 假 dws：status 队列控制行为；notify 记调用。
    const statusQueue = [
      // 第一轮：还在跑
      { name: "conv-e2e", streaming: true, finished: false, chars: 10, head: "H1", tail: "T1", status: "running" },
      // 第二轮：跑完，指纹变了
      { name: "conv-e2e", streaming: false, finished: true, chars: 500, head: "H2", tail: "T2", status: "ok" },
      // 第三轮：同指纹（重跑不发）
      { name: "conv-e2e", streaming: false, finished: true, chars: 500, head: "H2", tail: "T2", status: "ok" },
    ]
    const notified = []
    const dws = {
      status: async () => statusQueue.shift() ?? { name: "conv-e2e", streaming: false, finished: true, chars: 500, head: "H2", tail: "T2", status: "ok" },
      info: async () => ({ lastReply: '<RESULT>{"status":"done","summary":"做完了"}</RESULT>' }),
      notify: async (target, text) => {
        notified.push({ target, text })
      },
    }

    server = await startServer({ cfg, book, dws, log: () => {} })

    // 第一轮 running → 不通知
    let r = await server.poll()
    assert.equal(r.checked, 1)
    assert.equal(r.settled, 0)
    assert.equal(r.notified, 0)
    assert.equal(notified.length, 0)

    // 第二轮 finished + 指纹变化 → 通知 1 次
    r = await server.poll()
    assert.equal(r.settled, 1)
    assert.equal(r.notified, 1)
    assert.equal(notified.length, 1)
    assert.equal(notified[0].target, "boss")
    assert.match(notified[0].text, /【foreman】demo\/demo #1/)

    // 第三轮同指纹 → 不发
    r = await server.poll()
    assert.equal(r.notified, 0)
    assert.equal(notified.length, 1)

    // 关闭服务（模拟重启）
    await server.close()
    server = null

    // 新起一个服务（新进程状态），但 notified 已持久化
    const server2 = await startServer({ cfg, book: new Book(cfg.stateFile), dws, log: () => {} })
    try {
      r = await server2.poll()
      assert.equal(r.notified, 0, "重启后不重发")
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

// 真实踩到的坑：dws 把消息发进会话了，却回一个「豆包没有把这条消息发出去」。
// 服务按失败处理、账本没记指纹，于是每轮 poll 又补一遍，调用方会话被刷成重复通知。
test("notify 报假失败 → 同一指纹最多发 maxAttempts 次，不再每轮重发", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir, { notify: { enabled: true, session: "boss", maxAttempts: 2, events: ["done"] } })
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-ghost", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    const sent = []
    const dws = {
      status: async () => ({ name: "conv-ghost", streaming: false, finished: true, chars: 100, head: "H", tail: "T", status: "ok" }),
      info: async () => ({ lastReply: '<RESULT>{"status":"done","summary":"做完了"}</RESULT>' }),
      // 每次都“报失败”，但消息其实已经到了（sent 记下来模拟真实投递）
      notify: async (target, text) => {
        sent.push({ target, text })
        throw new Error("dws send 失败：✗ 豆包没有把这条消息发出去")
      },
    }
    server = await startServer({ cfg, book, dws, log: () => {} })
    let notified = 0
    for (let i = 0; i < 5; i++) {
      const r = await server.poll()
      notified += r.notified
    }
    assert.equal(sent.length, 2, "同一指纹只发两次（首发 + 一次补偿），不随 poll 轮数增长")
    assert.equal(notified, 0, "报失败时不计 notified")
    const led = new Book(cfg.stateFile).notified["conv-ghost"]
    assert.equal(led.attempts, 2)
    assert.match(led.lastError, /没有把这条消息发出去/) 
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
