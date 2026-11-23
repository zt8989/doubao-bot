// 续接调度：跑完一个 → 槽位空 + 有活就催继续接；不是 done 就催去看。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { plannerDecision, plannerTarget, plannerText, loadQueue, runningIssues } from "../src/planner.mjs"
import { startServer } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-plan-"))
}

function mkCfg(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    agent: "dws",
    pollSeconds: 20,
    maxAttempts: 3,
    repos: [{ name: "demo", repo: "demo/demo", dir: dir, base: "sit-20261126", labelIds: [5] }],
    pickup: { me: "233151", priority: ["mine", "unassigned", "others"], order: "oldest", excludeLabels: [] },
    notify: { enabled: true, session: "auto", events: ["done", "pr-open", "needs-human", "blocked", "failed"] },
    merge: { enabled: false },
    planner: { enabled: true, maxRunning: 2, target: "boss", listLimit: 5 },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
    },
    ...over,
  }
}

const issue = (n, extra = {}) => ({
  number: n, title: `#${n}`, state: "open", labels: [], assignees: [],
  author: "zhangsan", url: "", createdAt: "2026-11-01T00:00:00Z", ...extra,
})

test("plannerDecision：开关、槽位、done、去重", () => {
  const dir = tmpDir()
  try {
    const book = new Book(path.join(dir, "state.json"))
    const base = mkCfg(dir).planner

    assert.equal(plannerDecision({ cfg: { planner: { enabled: false } }, book, result: { status: "done" }, key: "k" }).reason, "disabled")
    assert.equal(plannerDecision({ cfg: { planner: base }, book, result: { status: "done", pr: 9 }, key: "k" }).kind, "continue")

    book.setIssue("demo/demo#1", { state: "working" })
    book.setIssue("demo/demo#2", { state: "working" })
    const r = plannerDecision({ cfg: { planner: base }, book, result: { status: "done" }, key: "k" })
    assert.equal(r.send, false, "在跑 2 条（>=2）不催")
    assert.equal(r.reason, "running-2")

    const chk = plannerDecision({ cfg: { planner: base }, book, result: { status: "blocked" }, key: "k2" })
    assert.equal(chk.kind, "check", "不是 done 就让它去看，不受槽位限制")

    book.markPlanner("k", { kind: "continue" })
    assert.equal(plannerDecision({ cfg: { planner: base }, book, result: { status: "done" }, key: "k" }).reason, "already")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("loadQueue：跨仓库取可接工单，按三档排序并截断；已处理的不进队列", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, {
      repos: [
        { name: "a", repo: "demo/a", base: "sit-20261126", labelIds: [5] },
        { name: "b", repo: "demo/b", base: "sit-20261126", labelIds: [5] },
      ],
      planner: { enabled: true, maxRunning: 2, target: "boss", listLimit: 2 },
    })
    const book = new Book(cfg.stateFile)
    book.setIssue("demo/a#9", { state: "done" })
    const gitea = {
      listIssues: async (repo) => (repo === "demo/a"
        ? [issue(1), issue(2, { author: "233151" }), issue(9)]
        : [issue(3, { assignees: ["wangwu"] })]),
    }
    const q = await loadQueue({ cfg, book, gitea, limit: 2 })
    assert.equal(q.length, 2, "limit 截断")
    assert.equal(q[0].number, 2, "我的排最前")
    assert.equal(q[0].repo, "demo/a")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("plannerText：继续接单带工单列表，not-done 带原因与 retry 提示", () => {
  const cfg = mkCfg(tmpDir())
  const t1 = plannerText({
    cfg, kind: "continue", watcher: { issueKey: "demo/demo#1" },
    result: { status: "done" }, running: 1, maxRunning: 2,
    issues: [{ repo: "demo/demo", number: 2, title: "改配置", author: "233151" }],
  })
  assert.match(t1, /可以继续接单/)
  assert.match(t1, /在跑 1\/2/)
  assert.match(t1, /demo\/demo #2 【我的】改配置/)
  assert.match(t1, /foreman run --once/)

  const t2 = plannerText({ cfg, kind: "check", watcher: { issueKey: "demo/demo#1", repo: "demo/demo", number: 1 }, result: { status: "blocked", summary: "依赖装不上" } })
  assert.match(t2, /需要你看一下/)
  assert.match(t2, /依赖装不上/)
  assert.match(t2, /foreman retry demo 1/)
})

test("poll：完成回复只入箱并由 Worker queue，不自动开 PR 或改业务状态", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-work", name: "foreman-demo-1", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    book.setIssue("demo/demo#1", { state: "working", title: "测试单" })

    const sends = []
    const gitea = {
      listPulls: async () => [],
      listIssues: async () => [issue(2, { author: "233151" }), issue(3)],
      mergePr: async () => {},
      closeIssue: async () => {},
    }
    const dws = {
      runningMap: async () => ({ "conv-work": { running: false } }),
      status: async () => ({ streaming: false, finished: true, chars: 120, head: "h", tail: "t" }),
      info: async () => ({ lastReply: "改完，已 commit，相关测试通过。" }),
      queue: async (target, text) => { sends.push({ target, text }) },
      notify: async () => { throw new Error("旧 notify 不应参与任务状态投递") },
    }
    server = await startServer({ cfg, book, dws, gitea, log: () => {} })

    const r = await server.poll()
    assert.equal(r.notified, 0)
    await server.worker.idle()
    await server.worker.runOnce()
    assert.equal(sends.length, 1)
    const rec = new Book(cfg.stateFile).issue("demo/demo#1")
    assert.equal(rec.state, "working", "业务状态由编排判断")
    assert.equal(rec.pr, undefined)
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("poll：阻塞文本不自动改 blocked，Worker 只负责投递", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-work", name: "foreman-demo-1", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })
    book.setIssue("demo/demo#1", { state: "working", title: "测试单" })
    const sends = []
    const gitea = { listPulls: async () => [], listIssues: async () => [issue(2)], mergePr: async () => {}, closeIssue: async () => {} }
    const dws = {
      runningMap: async () => ({ "conv-work": { running: false } }),
      status: async () => ({ streaming: false, finished: true, chars: 120, head: "h", tail: "t" }),
      info: async () => ({ lastReply: "还缺依赖，未能完成。" }),
      queue: async (target, text) => { sends.push({ target, text }) },
      notify: async () => { throw new Error("旧 notify 不应参与任务状态投递") },
    }
    server = await startServer({ cfg, book, dws, gitea, log: () => {} })
    await server.poll()
    await server.worker.idle()
    await server.worker.runOnce()
    assert.equal(sends.length, 1)
    assert.equal(new Book(cfg.stateFile).issue("demo/demo#1").state, "working", "阻塞原因只交编排判断")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runningIssues 数 planned/working/pr-open（PR 开着还没关单也占名额）", () => {
  const book = { issues: { a: { state: "working" }, b: { state: "planned" }, c: { state: "pr-open" }, d: { state: "failed" } } }
  assert.deepEqual(runningIssues(book).map((x) => x.key), ["a", "b", "c"])
})
