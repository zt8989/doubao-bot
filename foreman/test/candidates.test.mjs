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

test("待分配列表：只列账本里还没处理过的单，并按归属分档", async () => {
  forgetCandidates()
  const stateFile = tmpState()
  const book = new Book(stateFile)
  book.setIssue("yyzl/win-ai-harness#2", { state: "done", repo: repoCfg.repo, issue: 2 })
  book.setIssue("yyzl/win-ai-harness#3", { state: "handed", repo: repoCfg.repo, issue: 3 })

  const c = cfg({ stateFile })
  const ctx = { cfg: c, gitea: fakeGitea([
    issue(1),
    issue(2),
    issue(3),
    issue(4, { author: "someone-else", assignees: ["someone"] }),
    issue(5, { labels: ["needs-human"] }),
  ]) }

  const r = await candidatesOnce(ctx)
  assert.equal(r.ok, true)
  assert.deepEqual(r.items.map((i) => i.number), [1, 4], "done/handed/排除标签的单都不进队列")
  assert.equal(r.items.find((i) => i.number === 1).bucket, "mine")
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
