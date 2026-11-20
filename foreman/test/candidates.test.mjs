import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { candidatesOnce, pickIssue, forgetCandidates } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

const tmpState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-cand-"))
  return path.join(dir, "state.json")
}

const repoCfg = { name: "win-ai-harness", repo: "yyzl/win-ai-harness", dir: "/tmp/x", base: "sit-20261126" }

function cfg(over = {}) {
  return {
    stateFile: over.stateFile,
    repos: [repoCfg],
    gitea: { baseUrl: "http://gitea.test" },
    perRepoPerRound: 1,
    maxAttempts: 3,
    pickup: {
      labelIds: [5],
      excludeLabels: ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"],
      onlyUnassigned: false,
      order: "oldest",
      me: "233151",
      priority: ["mine", "unassigned", "others"],
      auto: false,
      maxRunning: 2,
      handToOrchestrator: true,
      ...over.pickup,
    },
    workHours: { enabled: false },
    ...over,
  }
}

const issue = (n, extra = {}) => ({
  number: n,
  title: `#${n}`,
  labels: [],
  assignees: [],
  author: "233151",
  createdAt: "2026-11-10T00:00:00Z",
  ...extra,
})

// 假的 gitea：listIssues 返回给定列表，viewIssue 直接拼一条。
const fakeGitea = (list) => ({
  listIssues: async () => list,
  viewIssue: async (repo, n) => ({ ...issue(n), number: n, body: "正文" }),
})

test("待分配列表：列出全部 open 工单（不看接单标签），只按账本去重", async () => {
  forgetCandidates()
  const stateFile = tmpState()
  const book = new Book(stateFile)
  book.setIssue("yyzl/win-ai-harness#2", { state: "done", repo: repoCfg.repo, issue: 2 })
  book.setIssue("yyzl/win-ai-harness#3", { state: "handed", repo: repoCfg.repo, issue: 3 })

  const c = cfg({ stateFile })
  const ctx = { cfg: c, gitea: fakeGitea([
    issue(1, { labels: ["ready-for-agent", "needs-triage"] }),
    issue(2),
    issue(3),
    issue(4, { author: "someone-else", assignees: ["someone"] }),
    issue(5, { labels: ["needs-human"] }),
  ]) }

  const r = await candidatesOnce(ctx)
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.items.map((i) => i.number),
    [1, 5, 4],
    "done/handed 的不列；没打接单标签的、带 needs-human 的都列（排序：我的 → 他人）"
  )
  assert.equal(r.items.find((i) => i.number === 1).bucket, "mine")
  assert.deepEqual(r.items.find((i) => i.number === 1).labels, ["ready-for-agent", "needs-triage"], "接口把全部工单标签带给页面")
  assert.deepEqual(r.items.find((i) => i.number === 5).labels, ["needs-human"], "人工类标签也不能被过滤或丢掉")
  assert.equal(r.items.find((i) => i.number === 4).bucket, "others")
  assert.equal(r.items[0].url, "http://gitea.test/yyzl/win-ai-harness/issues/1", "库里没有 url 时按仓库拼")
  assert.equal(r.capacity.maxRunning, 2)
  assert.equal(r.pickup.auto, false)
})

test("待分配列表带缓存：短时间内重复请求不重新拉，refresh 才强拉", async () => {
  forgetCandidates()
  const stateFile = tmpState()
  let calls = 0
  const ctx = {
    cfg: cfg({ stateFile }),
    gitea: {
      listIssues: async () => {
        calls++
        return [issue(1)]
      },
    },
  }
  await candidatesOnce(ctx)
  assert.equal(calls, 1)
  const cached = await candidatesOnce(ctx)
  assert.equal(calls, 1, "第二次走缓存")
  assert.equal(cached.cached, true)
  await candidatesOnce(ctx, { refresh: true })
  assert.equal(calls, 2, "refresh 绕过缓存")
})

test("待分配列表：某个仓库拉不到工单时只记错误，不拖垮整页", async () => {
  forgetCandidates()
  const stateFile = tmpState()
  const c = cfg({ stateFile, repos: [repoCfg, { ...repoCfg, name: "b", repo: "yyzl/b" }] })
  const ctx = {
    cfg: c,
    gitea: {
      listIssues: async (repo) => {
        if (repo === "yyzl/b") throw new Error("401 未登录")
        return [issue(1)]
      },
    },
  }
  const r = await candidatesOnce(ctx)
  assert.equal(r.items.length, 1)
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0].message, /401/)
})

test("待分配列表：按「我的 → 无人认领 → 他人认领」排，最多 10 条", async () => {
  forgetCandidates()
  const stateFile = tmpState()
  const list = []
  // 12 条他人认领 + 1 条无人认领 + 2 条我的：mine 必须挤进前 10，others 被截断。
  for (let n = 1; n <= 12; n++) {
    list.push(issue(n, { author: "someone-else", assignees: ["someone"], createdAt: `2026-11-${String(n).padStart(2, "0")}T00:00:00Z` }))
  }
  list.push(issue(20, { author: "someone-else", assignees: [], createdAt: "2026-11-02T00:00:00Z" }))
  list.push(issue(21, { createdAt: "2026-11-03T00:00:00Z" }))
  list.push(issue(22, { createdAt: "2026-11-01T00:00:00Z" }))
  const ctx = { cfg: cfg({ stateFile }), gitea: fakeGitea(list) }
  const r = await candidatesOnce(ctx)
  assert.equal(r.total, 15)
  assert.equal(r.items.length, 10)
  assert.deepEqual(
    r.items.slice(0, 3).map((i) => [i.number, i.bucket]),
    [
      [22, "mine"],
      [21, "mine"],
      [20, "unassigned"],
    ],
    "mine 优先，同档按创建时间老的在前"
  )
  assert.ok(r.items.slice(3).every((i) => i.bucket === "others"))
})

test("手动接单：账本里已处理/在跑的单不重复派", async () => {
  const stateFile = tmpState()
  const book = new Book(stateFile)
  book.setIssue("yyzl/win-ai-harness#7", { state: "done", repo: repoCfg.repo, issue: 7 })
  book.setIssue("yyzl/win-ai-harness#8", { state: "working", repo: repoCfg.repo, issue: 8 })
  book.setIssue("yyzl/win-ai-harness#9", { state: "pr-open", repo: repoCfg.repo, issue: 9 })

  const ctx = { cfg: cfg({ stateFile }), gitea: fakeGitea([]), log: () => {} }
  assert.equal((await pickIssue(ctx, { repo: repoCfg.repo, number: 7 })).error, "already-handled")
  assert.equal((await pickIssue(ctx, { repo: repoCfg.repo, number: 8 })).error, "running")
  assert.equal((await pickIssue(ctx, { repo: repoCfg.repo, number: 9 })).error, "already-handled")
  assert.equal((await pickIssue(ctx, { repo: "yyzl/nope", number: 1 })).error, "unknown-repo")
  assert.equal((await pickIssue(ctx, { repo: repoCfg.repo, number: 0 })).error, "bad-request")
})

test("手动接单：接单节点被暂停时不派", async () => {
  const stateFile = tmpState()
  const ctx = {
    cfg: cfg({ stateFile }),
    gitea: fakeGitea([]),
    log: () => {},
    engine: { paused: (stage) => stage === "pickup" },
  }
  const r = await pickIssue(ctx, { repo: repoCfg.repo, number: 11 })
  assert.equal(r.ok, false)
  assert.equal(r.error, "node-paused")
})

test("手动接单：run.lock 被别人占着就拒绝，不硬派", async () => {
  const stateFile = tmpState()
  const lockFile = path.join(path.dirname(stateFile), "run.lock")
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  // 用当前进程 pid 占锁：acquireLock 认「活着的 pid」就会拒绝。
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const ctx = { cfg: cfg({ stateFile }), gitea: fakeGitea([]), log: () => {} }
  const r = await pickIssue(ctx, { repo: repoCfg.repo, number: 12 })
  assert.equal(r.ok, false)
  assert.equal(r.error, "locked")
  fs.rmSync(lockFile, { force: true })
})

test("决策单提示词：先调研，切换 ready-for-agent 后才能编码，不确定可发邮件", async () => {
  const { decisionKickoff } = await import("../src/prompts.mjs")
  const p = decisionKickoff({
    repo: repoCfg.repo,
    issue: issue(30, { title: "这个要不要做", body: "正文" }),
    base: "sit-20261126",
    labels: ["needs-info"],
    workspaces: [{ repo: repoCfg.repo, branch: "fix/issue-30", worktree: "/tmp/wt", base: "sit-20261126" }],
  })
  assert.match(p, /决策会话/)
  assert.match(p, /needs-info/)
  assert.match(p, /这一步只做调研，不改业务代码/)
  assert.match(p, /可选方案和你的推荐/)
  assert.match(p, /foreman send --type mail/)
  assert.match(p, /--label-add ready-for-agent/)
  assert.match(p, /ready-for-human 已移除后，才能开始编码/)
  assert.match(p, /标签切换或核验失败时停止编码/)
  assert.doesNotMatch(p, /只使用只读能力/, "决策单需要允许修改本单标签")
  assert.match(p, /没有人监听/)
  assert.match(p, /直接给出最终回复/)
  assert.match(p, /\/tmp\/wt/, "仍给工作区：调研后确认可做并完成标签切换才改")
})

test("手动接单：带 needs-info 标签走决策单 → 写 router Inbox（issue.decision），不直接开会话", async () => {
  const stateFile = tmpState()
  const sent = []
  const ctx = {
    cfg: cfg({ stateFile }),
    dryRun: true,
    log: () => {},
    gitea: {
      viewIssue: async () => ({ ...issue(31), title: "信息不足的单", labels: ["needs-info"], body: "正文" }),
    },
    notifyRouter: async (envelope) => {
      sent.push(envelope)
      return { ok: true, action: "inbox", eventId: "evt-decision-31" }
    },
  }
  const r = await pickIssue(ctx, { repo: repoCfg.repo, number: 31 })
  assert.equal(r.ok, true)
  assert.equal(r.decision, true)
  assert.equal(r.state, "inbox")
  assert.equal(r.eventId, "evt-decision-31")
  assert.equal(sent.length, 1, "决策单必须写一条 router Inbox")
  assert.equal(sent[0].type, "issue.decision")
  assert.match(sent[0].text, /foreman decide yyzl\/win-ai-harness#31/)
  assert.match(sent[0].text, /needs-info/)
  assert.equal(sent[0].json.issue.number, 31)
  const rec = new Book(stateFile).issue(`${repoCfg.repo}#31`)
  assert.equal(rec.state, "planned", "决策单先记 planned，等 router 派 decide 才转 working")
  assert.equal(rec.decision, true)
})

test("手动接单：普通工单仍走标准派单提示词", async () => {
  const stateFile = tmpState()
  const ctx = {
    cfg: cfg({ stateFile }),
    dryRun: true,
    log: () => {},
    gitea: { viewIssue: async () => ({ ...issue(32), title: "普通单", labels: [], body: "正文" }) },
  }
  const r = await pickIssue(ctx, { repo: repoCfg.repo, number: 32 })
  assert.equal(r.ok, true)
  assert.equal(r.decision, false)
  assert.match(r.prompt, /工作会话 · yyzl\/win-ai-harness#32/)
  assert.doesNotMatch(r.prompt, /决策会话/)
})
