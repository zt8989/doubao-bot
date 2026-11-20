import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { earliestCaller, prWatchTarget, shouldReport, prNotifyText, prWatchOnce, ownedPrKeys } from "../src/prwatch.mjs"
import { startServer, prPollOnce, handleRequest, deliverMergeCandidate } from "../src/service.mjs"
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
  // 没有明确作者就不能证明是「他人 PR」，交给后续扫描补全，不分配。
  assert.equal(shouldReport({ ...pr, author: null }, cfg), false)
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

test("prNotifyText：列出待合并 PR，明确核对后直接执行合并", () => {
  const text = prNotifyText([{ repo: "demo/demo", number: 2, title: "改了点东西", author: "zhangsan", url: "http://x/pulls/2" }])
  assert.match(text, /核对后可合的请直接合并/)
  assert.match(text, /demo\/demo#2 改了点东西/)
  assert.match(text, /作者：zhangsan/)
  assert.match(text, /合并：foreman pr merge 2 --repo demo\/demo/)
  assert.match(text, /可合就直接执行上面的合并命令/)
  assert.match(text, /若工单或 PR 涉及 UI/)
  assert.match(text, /只有用户明确回复「合并」后才能执行合并/)
  assert.match(text, /不要输出 RESULT/)
  assert.doesNotMatch(text, /人工兜底/)
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

test("ownedPrKeys：从 issues 账本收集自家 PR（含跨工程 prs[]）", () => {
  const book = {
    issues: {
      "demo/demo#11": { pr: 21, prs: [{ repo: "demo/other", pr: 22 }] },
      "demo/skip#12": { state: "done" },
    },
  }
  const keys = ownedPrKeys(book)
  assert.ok(keys.has("demo/demo#21"))
  assert.ok(keys.has("demo/other#22"))
  assert.equal(keys.size, 2)
})

test("prWatchOnce：issues 账本里挂着 PR 的自家单，author 为空也不再报", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    // foreman pr open 建完 PR 后写进 issues 账本：这条 PR 是自家单的
    const book = new Book(cfg.stateFile)
    book.record("caller-1", { convId: "conv-first" })
    book.setIssue("demo/demo#7", { pr: 7, state: "pr-open" })

    // Gitea 列表把作者丢了（流水线账号 / 解析为空），账本 prWatch 里没有这条
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 7, title: "自家的", author: "", url: "http://x/pulls/7", state: "open" }] }
    const sent = []
    const dws = { notify: async (target, text) => sent.push({ target, text }) }

    const r = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r.notified, 0)
    assert.equal(sent.length, 0)
    assert.equal(new Book(cfg.stateFile).prSeen["demo/demo#7"], undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prWatchOnce：账本里登记过 skipped=self 的自家 PR，author 解析为空也不再报", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    // 模拟 foreman pr open 建完 PR 后的登记：author 记的是自己，skipped=self
    const book = new Book(cfg.stateFile)
    book.record("caller-1", { convId: "conv-first" })
    book.markPrSeen("demo/demo#7", { repo: "demo/demo", number: 7, title: "自家的", author: "233151", skipped: "self" })

    // Gitea 列表把作者丢了（流水线账号 / 解析为空）
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 7, title: "自家的", author: "", url: "http://x/pulls/7", state: "open" }] }
    const sent = []
    const dws = { notify: async (target, text) => sent.push({ target, text }) }

    const r = await prWatchOnce({ cfg, gitea, dws, log: () => {} })
    assert.equal(r.notified, 0)
    assert.equal(sent.length, 0)
    assert.equal(new Book(cfg.stateFile).prSeen["demo/demo#7"].notifiedAt, "")
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

    const opened = []
    const dws = {
      openNew: async (args) => { opened.push(args); return { convId: "inspector-1" } },
      queue: async () => { throw new Error("首次通知应直接随检查会话首句进入") },
    }
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 4, title: "新单", author: "wangwu", url: "http://x/pulls/4" }] }

    server = await startServer({ cfg, book, dws, gitea, log: () => {} })
    const r = await server.prPoll()
    await server.worker.idle()
    assert.equal(r.notified, 1)
    assert.equal(opened.length, 1)
    assert.match(opened[0].prompt, /demo\/demo#4/)
    assert.match(opened[0].prompt, /foreman pr merge 4 --repo demo\/demo/)
    assert.doesNotMatch(opened[0].prompt, /foreman pr assign 4 --repo demo\/demo/, "他人 PR 不再经路由中转")

    const again = await server.prPoll()
    assert.equal(again.notified, 0)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("服务里 prPoll：sessionFlow 开启时 PR 仍只交router agent，不 steer 全局编排", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    cfg.sessionFlow = { enabled: true }
    cfg.deliver = { mode: "new" }
    new Book(cfg.stateFile).setOrchestrator({ convId: "conv-global", name: "foreman-编排" })

    const inspected = []
    const steered = []
    const ctx = {
      cfg,
      state: { pr: { polling: false, pollCount: 0, notifiedCount: 0, pending: 0 } },
      log: () => {},
      gitea: {
        listPulls: async () => [{ repo: "demo/demo", number: 5, title: "待合并", author: "wangwu", url: "http://x/pulls/5" }],
        viewPr: async () => ({ mergeNote: "可以合并", state: "open" }),
      },
      dws: {
        steer: async (target) => { steered.push(target) },
      },
      notifyInspector: async (text) => {
        inspected.push(text)
        return { ok: true, convId: "inspector-1" }
      },
    }

    const out = await prPollOnce(ctx)
    assert.equal(out.notified, 1)
    assert.equal(out.via, "inspector")
    assert.equal(inspected.length, 1)
    assert.match(inspected[0].text, /http:\/\/x\/pulls\/5/)
    assert.match(inspected[0].text, /foreman pr assign 5 --repo demo\/demo/)
    assert.equal(inspected[0].type, "pr.candidates")
    assert.deepEqual(inspected[0].json.prs.map((pr) => pr.key), ["demo/demo#5"])
    assert.equal(inspected[0].json.prs[0].url, "http://x/pulls/5")
    assert.deepEqual(steered, [], "PR 不能 steer 到全局编排")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("PR 扫描把他人候选直投合并会话，自己的和作者不明的仍在扫描阶段排除", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    new Book(cfg.stateFile).data.inspector = { convId: "inspector-1", name: "检查" }
    const gitea = {
      listPulls: async () => [
        { repo: "demo/demo", number: 70, title: "自己的", author: "233151", url: "http://x/pulls/70" },
        { repo: "demo/demo", number: 71, title: "作者不明", author: "", url: "http://x/pulls/71" },
        { repo: "demo/demo", number: 72, title: "他人的", author: "zhangsan", url: "http://x/pulls/72" },
      ],
      viewPr: async () => ({ mergeNote: "可以合并", state: "open" }),
    }
    const inspected = []
    const delivered = []
    const out = await prWatchOnce({
      cfg, gitea, dws: {}, log: () => {},
      inspect: async (text) => { inspected.push(text); return { ok: true, convId: "inspector-1" } },
      deliver: async (args) => { delivered.push(args); return { session: "foreman-合并-72", convId: "merge-72" } },
    })
    assert.equal(out.notified, 1)
    assert.equal(out.via, "merge-direct")
    assert.equal(inspected.length, 0, "他人 PR 不再惊动 router agent")
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].text, /demo\/demo#72/)
    assert.match(delivered[0].text, /foreman pr merge 72 --repo demo\/demo/)
    assert.doesNotMatch(delivered[0].text, /demo\/demo#70|demo\/demo#71/)
    assert.equal(delivered[0].kind, "PR待合并")
    assert.equal(delivered[0].lane, "merge")
    const seen = new Book(cfg.stateFile).prSeen
    assert.equal(seen["demo/demo#70"].skipped, "self")
    assert.equal(seen["demo/demo#71"].skipped, "unknown-author")
    assert.equal(seen["demo/demo#72"].notifiedTo, "foreman-合并-72")
    assert.equal(seen["demo/demo#72"].assignedTo, "foreman-合并-72")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("服务 PR 扫描把他人 PR 直投合并会话，不再绕路由", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    cfg.deliver = { mode: "new" }
    const inspected = []
    const delivered = []
    const ctx = {
      cfg,
      state: { pr: { polling: false, pollCount: 0, notifiedCount: 0, pending: 0 } },
      log: () => {},
      gitea: {
        listPulls: async () => [{ repo: "demo/demo", number: 73, title: "待分配", author: "zhangsan", url: "http://x/pulls/73" }],
        viewPr: async () => ({ mergeNote: "可以合并", state: "open" }),
      },
      dws: {},
      notifyInspector: async (text) => { inspected.push(text); return { ok: true, convId: "inspector-1" } },
      deliver: async (args) => { delivered.push(args); return { session: "foreman-合并-73", convId: "merge-73" } },
    }
    const out = await prPollOnce(ctx)
    assert.equal(out.notified, 1)
    assert.equal(out.via, "merge-direct")
    assert.equal(inspected.length, 0, "他人 PR 不再经路由中转")
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].lane, "merge")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("本人 UI PR 只 queue 验收指派候选，不进入他人合并助手链路", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    cfg.prWatch.uiReviewers = [
      { name: "周晓亮", username: "ywwb1328" },
      { name: "张振豪", username: "ywwb1797" },
    ]
    const inspected = []
    const gitea = {
      listPulls: async () => [{ repo: "demo/demo", number: 90, title: "调整页面", author: "233151", url: "http://x/pulls/90" }],
      viewPr: async () => ({ state: "open", author: "233151", files: [{ name: "src/App.vue" }], assignees: [] }),
    }
    const out = await prWatchOnce({
      cfg, gitea, dws: {}, log: () => {},
      inspect: async (text) => { inspected.push(text); return { ok: true, convId: "inspector-1" } },
      deliver: async () => { throw new Error("本人 UI PR 不能创建合并助手") },
    })
    assert.equal(out.notified, 1)
    assert.equal(out.uiNotified, 1)
    assert.equal(inspected.length, 1)
    assert.match(inspected[0].text, /本人 UI PR 待验收指派/)
    assert.match(inspected[0].text, /foreman pr ui-assign 90 --repo demo\/demo/)
    assert.doesNotMatch(inspected[0].text, /pr assign 90 --repo/)
    const seen = new Book(cfg.stateFile).prSeen["demo/demo#90"]
    assert.equal(seen.ui, true)
    assert.ok(seen.reviewNotifiedAt)
    assert.equal(seen.reviewAssignedAt, "")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pr ui-assign：本人 UI PR 在周晓亮和张振豪间轮询指派，重复调用幂等", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    cfg.prWatch.uiReviewers = [
      { name: "周晓亮", username: "ywwb1328" },
      { name: "张振豪", username: "ywwb1797" },
    ]
    const assigned = []
    const ctx = {
      cfg,
      state: {},
      gitea: {
        viewPr: async (_repo, number) => ({
          repo: "demo/demo", number, title: `页面 ${number}`, author: "233151", state: "open",
          files: [{ name: "src/App.vue" }], assignees: [],
        }),
        assign: async (_repo, number, username) => { assigned.push({ number, username }); return { ok: true } },
      },
    }
    const first = await handleRequest(ctx, { id: "ui-1", cmd: "pr ui-assign", repo: "demo/demo", number: 90 })
    const second = await handleRequest(ctx, { id: "ui-2", cmd: "pr ui-assign", repo: "demo/demo", number: 91 })
    const repeat = await handleRequest(ctx, { id: "ui-3", cmd: "pr ui-assign", repo: "demo/demo", number: 90 })
    assert.deepEqual(assigned, [
      { number: 90, username: "ywwb1328" },
      { number: 91, username: "ywwb1797" },
    ])
    assert.equal(first.reviewer.username, "ywwb1328")
    assert.equal(second.reviewer.username, "ywwb1797")
    assert.equal(repeat.skipped, "already-assigned")
    const seen = new Book(cfg.stateFile).prSeen
    assert.equal(seen["demo/demo#90"].reviewer, "ywwb1328")
    assert.equal(seen["demo/demo#91"].reviewer, "ywwb1797")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pr assign：只给他人 PR 分配合并助手，自己的和作者不明的拒绝，重复分配幂等", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const delivered = []
    const prs = {
      80: { repo: "demo/demo", number: 80, title: "自己的", author: "233151", state: "open" },
      81: { repo: "demo/demo", number: 81, title: "作者不明", author: "", state: "open" },
      82: { repo: "demo/demo", number: 82, title: "他人的", author: "zhangsan", state: "open", url: "http://x/pulls/82" },
    }
    const ctx = {
      cfg,
      state: {},
      gitea: { viewPr: async (_repo, number) => prs[number] },
      deliver: async (args) => {
        delivered.push(args)
        return { session: "foreman-合并-82", convId: "merge-82" }
      },
    }
    const own = await handleRequest(ctx, { id: "own", cmd: "pr assign", repo: "demo/demo", number: 80 })
    assert.equal(own.ok, false)
    assert.match(own.message, /233151|他人/)
    const unknown = await handleRequest(ctx, { id: "unknown", cmd: "pr assign", repo: "demo/demo", number: 81 })
    assert.equal(unknown.ok, false)
    assert.equal(delivered.length, 0)

    const first = await handleRequest(ctx, { id: "first", cmd: "pr assign", repo: "demo/demo", number: 82 })
    assert.equal(first.ok, true)
    assert.equal(first.convId, "merge-82")
    const second = await handleRequest(ctx, { id: "second", cmd: "pr assign", repo: "demo/demo", number: 82 })
    assert.equal(second.ok, true)
    assert.equal(second.skipped, "already-assigned")
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].text, /foreman pr merge 82 --repo demo\/demo/)
    const seen = new Book(cfg.stateFile).prSeen["demo/demo#82"]
    assert.equal(seen.assignedTo, "foreman-合并-82")
    assert.equal(seen.assignedConvId, "merge-82")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("合并会话投递失败时不记已通知，下一轮继续补发", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const gitea = {
      listPulls: async () => [{ repo: "demo/demo", number: 74, title: "待分配", author: "zhangsan" }],
      viewPr: async () => ({ mergeNote: "可以合并", state: "open" }),
    }
    const out = await prWatchOnce({
      cfg, gitea, dws: {}, log: () => {},
      deliver: async () => { throw new Error("dws 打不开合并会话") },
    })
    assert.equal(out.notified, 0)
    assert.equal(out.failedNotify, true)
    assert.equal(new Book(cfg.stateFile).prSeen["demo/demo#74"]?.notifiedAt ?? "", "")
  } finally {
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

test("prWatchOnce：代码检测 PR 更新，首次建基线，变化后交 router agent 决策且不重复", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const view = {
      repo: "demo/demo", number: 400, title: "统一列宽", author: "233151", state: "open",
      url: "http://x/pulls/400", mergeable: true, headSha: "head-a", updatedAt: "2026-11-20T01:26:31Z",
      comments: [{ id: 6986, author: "ywwb1797", body: "验证没问题，可以合并" }],
    }
    const gitea = {
      listPulls: async () => [{ repo: "demo/demo", number: 400, title: "统一列宽", author: "233151", url: "http://x/pulls/400", state: "open" }],
      viewPr: async () => view,
    }
    const inspected = []
    const inspect = async (event) => { inspected.push(event); return { ok: true, convId: "router-1" } }

    let out = await prWatchOnce({ cfg, gitea, dws: {}, log: () => {}, inspect })
    assert.equal(out.updatedNotified, 0, "首次扫描只建立基线，不路由历史状态")
    assert.equal(inspected.length, 0)
    assert.ok(new Book(cfg.stateFile).prSeen["demo/demo#400"].updateFingerprint)

    out = await prWatchOnce({ cfg, gitea, dws: {}, log: () => {}, inspect })
    assert.equal(out.updatedNotified, 0, "相同状态指纹不重复通知")
    assert.equal(inspected.length, 0)

    view.comments = [...view.comments, { id: 6987, author: "ywwb1328", body: "补充：验收通过" }]
    view.updatedAt = "2026-11-20T01:31:31Z"
    out = await prWatchOnce({ cfg, gitea, dws: {}, log: () => {}, inspect })
    assert.equal(out.updatedNotified, 1)
    assert.equal(inspected.length, 1)
    assert.equal(inspected[0].type, "pr.updates")
    assert.match(inspected[0].text, /demo\/demo#400/)
    assert.match(inspected[0].text, /新评论/)
    assert.match(inspected[0].text, /补充：验收通过/)
    assert.match(inspected[0].text, /是否合并、是否关闭关联 issue 由你决定/)
    assert.deepEqual(inspected[0].json.updates[0].changes, ["新评论"])
    assert.equal(inspected[0].json.updates[0].headSha, "head-a")

    out = await prWatchOnce({ cfg, gitea, dws: {}, log: () => {}, inspect })
    assert.equal(out.updatedNotified, 0)
    assert.equal(inspected.length, 1, "已路由的评论不重复通知")

    view.headSha = "head-b"
    view.updatedAt = "2026-11-20T01:36:31Z"
    out = await prWatchOnce({ cfg, gitea, dws: {}, log: () => {}, inspect })
    assert.equal(out.updatedNotified, 0, "单纯提交变化不通知 router agent")
    assert.equal(inspected.length, 1)

    view.comments = [...view.comments, { id: 6988, author: "ywwb1328", body: "新提交后再次验收" }]
    view.updatedAt = "2026-11-20T01:41:31Z"
    out = await prWatchOnce({ cfg, gitea, dws: {}, log: () => {}, inspect })
    assert.equal(out.updatedNotified, 1)
    assert.equal(inspected.length, 2)
    assert.deepEqual(inspected[1].json.updates[0].changes, ["新评论"])
    assert.equal(inspected[1].json.updates[0].headSha, "head-b")
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

test("PR 扫描只写 pr.merge Inbox，不建会话、不提前记已通知", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const gitea = {
      listPulls: async () => [{ repo: "demo/demo", number: 95, title: "他人的", author: "zhangsan", url: "http://x/pulls/95" }],
      viewPr: async () => ({ mergeNote: "可以合并", state: "open" }),
    }
    const events = []
    const delivered = []
    const out = await prWatchOnce({
      cfg, gitea, dws: {}, log: () => {},
      enqueue: async (event) => { events.push(event); return { id: 1, status: "pending" } },
      deliver: async () => { delivered.push(true); return { session: "不该建" } },
    })
    assert.equal(out.via, "inbox")
    assert.equal(out.notified, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, "pr.merge")
    assert.equal(events[0].payload.agent, "merge")
    assert.deepEqual(events[0].payload.prs.map((pr) => pr.key), ["demo/demo#95"])
    assert.match(events[0].payload.text, /foreman pr merge 95 --repo demo\/demo/)
    assert.equal(delivered.length, 0, "扫描阶段不建合并会话")
    const seen = new Book(cfg.stateFile).prSeen["demo/demo#95"]
    assert.equal(seen?.notifiedAt ?? "", "", "notifiedAt 由 Worker 投递成功后回写")
    assert.equal(seen?.assignedTo ?? "", "")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pr.merge Worker：建合并助手并记账，重复事件幂等不重复建", async () => {
  const dir = tmpDir()
  try {
    const cfg = baseCfg(dir)
    const delivered = []
    const ctx = {
      cfg,
      log: () => {},
      deliver: async (args) => { delivered.push(args); return { session: "foreman-合并-95", convId: "merge-95" } },
    }
    const event = {
      kind: "pr.merge",
      payload: {
        type: "pr.merge", agent: "merge",
        prs: [{ key: "demo/demo#95", repo: "demo/demo", number: 95, title: "他人的", author: "zhangsan", url: "http://x/pulls/95" }],
      },
    }
    const first = await deliverMergeCandidate(ctx, event)
    assert.equal(first.action, "assigned")
    assert.equal(first.session, "foreman-合并-95")
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].lane, "merge")
    const seen = new Book(cfg.stateFile).prSeen["demo/demo#95"]
    assert.equal(seen.assignedTo, "foreman-合并-95")
    assert.ok(seen.notifiedAt)
    assert.deepEqual(new Book(cfg.stateFile).notices["foreman-合并-95"].prs, ["demo/demo#95"])

    const second = await deliverMergeCandidate(ctx, event)
    assert.equal(second.skipped, "already-assigned")
    assert.equal(delivered.length, 1, "重复事件不再建会话")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
