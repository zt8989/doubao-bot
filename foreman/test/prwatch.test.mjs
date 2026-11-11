import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { earliestCaller, prWatchTarget, shouldReport, prNotifyText, prWatchOnce } from "../src/prwatch.mjs"
import { startServer, prPollOnce } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-pr-"))
}

function baseCfg(dir) {
  return {
    stateFile: path.join(dir, "state.json"),
    worktreeDir: path.join(dir, "worktrees"),
    pollSeconds: 20,
    timeoutMinutes: 90,
    maxAttempts: 3,
    perRepoPerRound: 1,
    pickup: { labelIds: [], labels: [], excludeLabels: [], onlyUnassigned: false, order: "oldest" },
    herdr: { bin: "herdr", enabled: false },
    merge: { enabled: false },
    notify: { enabled: true, session: "boss", events: ["done"] },
    prWatch: {
      enabled: true,
      intervalSeconds: 300,
      state: "open",
      maxPages: 3,
      ignoreAuthors: ["233151"],
      notifyTarget: "earliest",
    },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    repos: [{ name: "demo", repo: "demo/demo", dir: path.join(dir, "repo"), base: "sit-20261126", verify: [], labels: null }],
  }
}

test("shouldReport：作者不是 233151 才报", () => {
  const cfg = { prWatch: { ignoreAuthors: ["233151"] } }
  const pr = { repo: "demo/demo", number: 2, title: "t", author: "233151" }
  assert.equal(shouldReport(pr, cfg), false)
  assert.equal(shouldReport({ ...pr, author: "zhangsan" }, cfg), true)
  // 作者没解析出来时按要报处理，宁可多报不漏
  assert.equal(shouldReport({ ...pr, author: null }, cfg), true)
  // 没有编号/仓库的不算
  assert.equal(shouldReport({ repo: "", number: 2, author: "zhangsan" }, cfg), false)
})

test("earliestCaller：取 sessions 里第一个有 convId 的会话", () => {
  const book = { sessions: { a: { convId: "" }, b: { convId: "conv-b" }, c: { convId: "conv-c" } } }
  assert.equal(earliestCaller(book), "conv-b")
  assert.equal(earliestCaller({ sessions: {} }), "")
  assert.equal(earliestCaller(null), "")
})

test("prWatchTarget：写死目标优先，earliest/auto 回落最早调用方", () => {
  const book = { sessions: { first: { convId: "conv-first" } } }
  assert.equal(prWatchTarget({ prWatch: { notifyTarget: "conv-x" } }, book), "conv-x")
  assert.equal(prWatchTarget({ prWatch: { notifyTarget: "earliest" } }, book), "conv-first")
  assert.equal(prWatchTarget({ prWatch: { notifyTarget: "auto" } }, book), "conv-first")
  assert.equal(prWatchTarget({}, book), "conv-first")
})

test("prNotifyText：列出待合并 PR 并给「核对工单后合并」入口", () => {
  const text = prNotifyText([{ repo: "demo/demo", number: 2, title: "改了点东西", author: "zhangsan", url: "http://x/pulls/2" }])
  assert.match(text, /等你核对工单后合并/)
  assert.match(text, /demo\/demo#2 改了点东西/)
  assert.match(text, /作者：zhangsan/)
  assert.match(text, /foreman pr merge 2 --repo demo\/demo/)
  assert.doesNotMatch(text, /已自动合并/)
})

test("prWatchOnce：别人的 PR 报一次、自己的不报、重复扫描不重发", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const book = new Book(cfg.stateFile)
    book.record("caller-1", { convId: "conv-first" })

    const pages = {
      1: [
        { repo: "demo/demo", number: 1, title: "自己的", author: "233151", url: "http://x/pulls/1", state: "open" },
        { repo: "demo/demo", number: 2, title: "别人的", author: "zhangsan", url: "http://x/pulls/2", state: "open" },
      ],
      2: [],
    }
    const gitea = { listPulls: async (_repo, { page }) => pages[page] ?? [] }
    const sent = []
    const dws = { notify: async (target, text) => sent.push({ target, text }) }
    const log = () => {}

    let r = await prWatchOnce({ cfg, gitea, dws, log })
    assert.equal(r.notified, 1)
    assert.equal(r.target, "conv-first")
    assert.equal(sent.length, 1)
    assert.equal(sent[0].target, "conv-first")
    assert.match(sent[0].text, /demo\/demo#2 别人的/)
    assert.doesNotMatch(sent[0].text, /demo\/demo#1 /)

    const seen = new Book(cfg.stateFile).prSeen
    assert.equal(seen["demo/demo#1"].skipped, "self")
    assert.equal(seen["demo/demo#1"].notifiedAt, "")
    assert.ok(seen["demo/demo#2"].notifiedAt)

    r = await prWatchOnce({ cfg, gitea, dws, log })
    assert.equal(r.notified, 0)
    assert.equal(sent.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prWatchOnce：没有调用方会话时不发，等有了再补发", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 3, title: "待合并", author: "lisi", url: "http://x/pulls/3" }] }
    const sent = []
    const dws = { notify: async (target, text) => sent.push({ target, text }) }

    let r = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r.notified, 0)
    assert.equal(r.pending, 1)
    assert.equal(sent.length, 0)

    new Book(cfg.stateFile).record("caller-1", { convId: "conv-first" })
    r = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r.notified, 1)
    assert.equal(sent[0].target, "conv-first")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("服务里 prPoll：起服务后能手动跑一轮，状态里带 PR 计数", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = baseCfg(dir)
    cfg.prWatch.intervalSeconds = 3600
    const book = new Book(cfg.stateFile)
    book.record("caller-1", { convId: "conv-first" })

    const sent = []
    const dws = { notify: async (target, text) => sent.push({ target, text }) }
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 4, title: "新单", author: "wangwu", url: "http://x/pulls/4" }] }

    server = await startServer({ cfg, book, dws, gitea, log: () => {} })
    const r = await server.prPoll()
    assert.equal(r.notified, 1)
    assert.equal(sent[0].target, "conv-first")

    const again = await server.prPoll()
    assert.equal(again.notified, 0)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prWatchOnce：通知失败下一轮补发，发成功后不再重发", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    new Book(cfg.stateFile).record("caller-1", { convId: "conv-first" })
    let notifyFails = 1
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 6, title: "别人的", author: "zhangsan", url: "http://x/pulls/6" }] }
    const sent = []
    const dws = { notify: async (target, text) => { if (notifyFails-- > 0) throw new Error("dws 没开"); sent.push(text) } }

    const r1 = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r1.notified, 0)
    assert.equal(r1.failedNotify, true)
    assert.equal(sent.length, 0)

    const r2 = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r2.notified, 1)
    assert.equal(sent.length, 1)

    const r3 = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r3.notified, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prWatchOnce：默认过滤有冲突的 PR，不通知", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    new Book(cfg.stateFile).record("caller-1", { convId: "conv-first" })
    const gitea = {
      listPulls: async () => [
        { repo: "demo/demo", number: 8, title: "冲突单", author: "zhangsan", url: "http://x/pulls/8" },
        { repo: "demo/demo", number: 9, title: "正常单", author: "zhangsan", url: "http://x/pulls/9" },
      ],
      viewPr: async (_repo, n) => (n === 8
        ? { mergeNote: "此分支存在冲突，无法自动合并", state: "open" }
        : { mergeNote: "可以合并", state: "open" }),
    }
    const sent = []
    const dws = { notify: async (target, text) => sent.push(text) }
    const r = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r.notified, 1)
    assert.equal(r.conflicting, 1)
    assert.match(sent[0], /demo\/demo#9/)
    assert.doesNotMatch(sent[0], /demo\/demo#8 /)
    assert.equal(new Book(cfg.stateFile).prSeen["demo/demo#8"].skipped, "conflict")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prWatchOnce：filterConflicts=false 时冲突单照报", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    cfg.prWatch.filterConflicts = false
    new Book(cfg.stateFile).record("caller-1", { convId: "conv-first" })
    const gitea = {
      listPulls: async () => [{ repo: "demo/demo", number: 10, title: "冲突单", author: "zhangsan", url: "http://x/pulls/10" }],
      viewPr: async () => ({ mergeNote: "存在冲突", state: "open" }),
    }
    const sent = []
    const r = await prWatchOnce({ cfg, gitea, dws: { notify: async (_t, text) => sent.push(text) }, log: () => {} })
    assert.equal(r.notified, 1)
    assert.match(sent[0], /demo\/demo#10/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prWatch.enabled=false 时整条路径不跑", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    cfg.prWatch.enabled = false
    const gitea = { listPulls: async () => { throw new Error("不该调用 gitea") } }
    const r = await prWatchOnce({ cfg, gitea, dws: { notify: async () => {} }, log: () => {} })
    assert.equal(r.skipped, "disabled")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
