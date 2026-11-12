// 通用 workflow：生命周期事件、适配器契约、合并收尾流水线。
import test from "node:test"
import assert from "node:assert/strict"
import { Lifecycle, EVENTS, STAGES, WORKFLOWS, stagesOf, workflowsOf } from "../src/workflow/lifecycle.mjs"
import { assertSessionAdapter } from "../src/workflow/adapters/session.mjs"
import { DoubaoSessionAdapter } from "../src/workflow/adapters/doubao.mjs"
import { WorkflowEngine } from "../src/workflow/engine.mjs"
import { resolveIssueKey } from "../src/workflow/cleaners.mjs"
import { Book } from "../src/book.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("生命周期：两条流程（own 自有工单 / review 他人 PR），阶段与事件对得上", () => {
  const ids = Object.keys(WORKFLOWS)
  assert.deepEqual(ids, ["own", "review"])
  const own = stagesOf("own").map((s) => s.stage)
  for (const s of ["pickup", "workspace", "dispatch", "develop", "conclude", "pr-open", "merge", "close", "cleanup", "archive", "notify"]) {
    assert.ok(own.includes(s), `自有工单缺阶段 ${s}`)
  }
  const review = stagesOf("review").map((s) => s.stage)
  for (const s of ["scan", "review", "merge", "close", "cleanup", "archive", "notify"]) {
    assert.ok(review.includes(s), `他人 PR 缺阶段 ${s}`)
  }
  // review 不接单：他人的 PR 不该走 pickup / workspace / dispatch。
  assert.equal(review.includes("pickup"), false)
  assert.equal(EVENTS.merge, "pr.merged")
  assert.equal(EVENTS.archive, "session.archived")
  assert.equal(EVENTS["pr-open"], "pr.opened")
  // 共用阶段标明属于两条流程，专属阶段只属于一条。
  assert.deepEqual(workflowsOf("pr.merged"), ["own", "review"])
  assert.deepEqual(workflowsOf("issue.picked"), ["own"])
  assert.deepEqual(workflowsOf("pr.scanned"), ["review"])
})

test("Lifecycle：流程实例跟着事件推进阶段，关单即收口；暂停/计数只增不减", () => {
  const lc = new Lifecycle({ log: () => {} })
  lc.touchRun("own", "r#1", { stage: "pickup" })
  assert.equal(lc.active("own").length, 1)
  // 每个节点记自己的更新时间，控制台详情逐节点显示
  assert.ok(lc.runsList(20).find((r) => r.key === "r#1").stageAt.pickup, "节点要有更新时间")
  lc.touchRun("own", "r#1", { stage: "dispatch" })
  assert.equal(lc.active("own").length, 1, "同一张单只占一个名额")
  assert.ok(lc.runsList(20).find((r) => r.key === "r#1").stageAt.dispatch)
  lc.touchRun("own", "r#2", { stage: "pickup" })
  assert.equal(lc.active("own").length, 2)
  // 关单 = 收口，退出「在跑」计数
  lc.touchRun("own", "r#1", { stage: "close" })
  assert.equal(lc.active("own").length, 1)
  assert.equal(lc.active("own")[0].key, "r#2")
  // 恢复：账本里 working 的单补成流程实例
  const restored = lc.restore({ "r#3": { state: "working" }, "r#4": { state: "done" } })
  assert.equal(restored.length, 2)
  assert.equal(restored.some((r) => r.key === "r#4"), false, "已完成的不占用名额")
  // 合并关单、带 PR 的自有工单重启后补一条「走到 close 已完成」的记录，别再显示成未开始
  const done = lc.restore({ "r#5": { state: "done", pr: 88, updatedAt: "2026-11-12T07:45:00.000Z" } })
  const r5 = lc.runsList(20).find((r) => r.key === "r#5")
  assert.equal(r5.stage, "close")
  assert.equal(r5.status, "done")
  assert.equal(r5.pr, 88)
  assert.equal(done.some((r) => r.key === "r#5"), false, "完成的记录不占在跑名额")
})

test("Lifecycle：hooks 先跑、适配器按注册顺序跑，历史留痕；适配器报错不打断主流程", async () => {
  const calls = []
  const lc = new Lifecycle({
    adapters: {
      session: { on: async (e) => calls.push(`session:${e}`) },
      broken: { on: async () => { throw new Error("归档失败") } },
      workspace: { on: async (e) => calls.push(`workspace:${e}`) },
    },
    hooks: { "pr.merged": async () => calls.push("hook") },
    log: () => {},
  })
  await lc.emit("pr.merged", { issueKey: "r#1" })
  assert.deepEqual(calls, ["hook", "session:pr.merged", "workspace:pr.merged"])
  assert.equal(lc.history.length, 1)
  assert.equal(lc.history[0].stage, "merge")
  assert.equal(lc.history[0].key, "r#1")
})

test("SessionAdapter 契约：缺方法会被点名", () => {
  assert.throws(() => assertSessionAdapter({ status() {} }), /缺少方法/)
})

function fakeDriver() {
  const calls = { open: 0, send: 0, openNew: 0, archive: [] }
  return {
    calls,
    open: async () => { calls.open++; return { convId: "c1" } },
    send: async () => { calls.send++; return {} },
    openNew: async () => { calls.openNew++; return { convId: "c2" } },
    status: async () => ({ finished: true }),
    info: async () => ({ lastReply: "x" }),
    notify: async () => ({}),
    runningMap: async () => ({ "conv-run": { running: true }, "conv-idle": { running: false } }),
    archive: async (t) => { calls.archive.push(t); return {} },
  }
}

test("豆包 adapter：旧调用面与新契约都转到 driver；单实例护栏只报在跑的监听会话", async () => {
  const driver = fakeDriver()
  const a = new DoubaoSessionAdapter({ driver, cfg: {} })
  await a.open({ name: "n", prompt: "p" })
  await a.openExecution({ name: "n", prompt: "p" })
  await a.send("n", "p")
  await a.resumeExecution({ name: "n", prompt: "p" })
  await a.openNew({ name: "n", prompt: "p" })
  await a.deliver({ name: "n", prompt: "p" })
  assert.equal(driver.calls.open, 2)
  assert.equal(driver.calls.send, 2)
  assert.equal(driver.calls.openNew, 2)
  assert.equal(a.capabilities.singleInstance, true)
  assert.deepEqual(await a.busyWatchers(["conv-run", "conv-idle", "conv-unknown"]), ["conv-run"])
  assertSessionAdapter(a)
})

test("豆包 adapter：不再在 pr.merged 上顺手归档，归档归 archive 节点", async () => {
  const driver = fakeDriver()
  const a = new DoubaoSessionAdapter({ driver, cfg: {} })
  // 适配器只保留 archive() 能力；pr.merged 不再触发归档，避免和 archive 节点重复归档。
  await a.on("pr.merged", { target: "conv-1" })
  assert.deepEqual(driver.calls.archive, [])
})

test("engine.afterMerge：每个节点只清自己的产物，事件按 merge→close→cleanup→archive 落", async () => {
  const seq = []
  const driver = fakeDriver()
  const session = new DoubaoSessionAdapter({ driver, cfg: {} })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-nodes-"))
  const file = path.join(dir, "state.json")
  const book = new Book(file)
  book.setIssue("yyzl/win-ai-harness#268", {
    state: "pr-open", pr: 270, branch: "fix/issue-268", worktree: "/wt/fix-issue-268",
  })
  book.setWatch({ target: "conv-exec", name: "foreman-win-ai-harness-268", issueKey: "yyzl/win-ai-harness#268" })
  const closed = []
  const engine = new WorkflowEngine({
    cfg: { stateFile: file, repos: [{ repo: "yyzl/win-ai-harness", dir: "/w/harness" }] },
    session,
    tracker: {
      closeIssue: async (repo, n) => closed.push(`${repo}#${n}`),
      editLabels: async () => ({ changed: true }),
      on: async () => {},
    },
    workspace: {
      cleanup: async ({ worktree }) => {
        seq.push(`cleanup:${worktree}`)
        return { notes: ["worktree 已删除"] }
      },
      on: async () => {},
    },
    log: () => {},
  })
  try {
    const out = await engine.afterMerge({
      watcher: { target: "conv-exec", issueKey: "yyzl/win-ai-harness#268" },
      merge: { key: "yyzl/win-ai-harness#270", repo: "yyzl/win-ai-harness", pr: 270, issueNumber: 268 },
      book,
    })
    // workspace 节点清工作区、dispatch 节点摘监听、close 节点关单、archive 节点归档
    assert.deepEqual(seq, ["cleanup:/wt/fix-issue-268"])
    assert.deepEqual(closed, ["yyzl/win-ai-harness#268"])
    assert.ok(out.notes.some((n) => n.includes("worktree 已删除")))
    assert.ok(out.notes.some((n) => n.includes("摘掉 1 条执行会话监听")))
    assert.deepEqual(driver.calls.archive, ["conv-exec"])
    const b = new Book(file)
    assert.equal(b.issue("yyzl/win-ai-harness#268").state, "done")
    assert.equal(b.mergeAsk["yyzl/win-ai-harness#270"].status, "merged")
    assert.equal(b.prSeen["yyzl/win-ai-harness#270"].merged, true)
    assert.deepEqual(b.watch.map((w) => w.issueKey), [], "这张单的监听摘干净")
    assert.deepEqual(out.nodes, ["merge", "close", "pr-open", "dispatch", "workspace", "cleanup", "archive"])
    const events = engine.lifecycle.history.map((h) => h.event)
    assert.deepEqual(events, ["pr.merged", "issue.closed", "workspace.cleaned", "session.archived"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("engine.afterMerge：没有 worktree 记录时 workspace 节点跳过，其它节点照常", async () => {
  const driver = fakeDriver()
  const closed = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-nodes-"))
  const file = path.join(dir, "state.json")
  const book = new Book(file)
  book.setIssue("r#1", { state: "pr-open", pr: 2 })
  const engine = new WorkflowEngine({
    cfg: { stateFile: file, repos: [] },
    session: new DoubaoSessionAdapter({ driver, cfg: {} }),
    tracker: { closeIssue: async (repo, n) => closed.push(n), on: async () => {} },
    workspace: { cleanup: async () => { throw new Error("不该被调用") }, on: async () => {} },
    log: () => {},
  })
  try {
    const out = await engine.afterMerge({
      watcher: { target: "conv-x", issueKey: "r#1" },
      merge: { key: "r#2", repo: "r", pr: 2, issueNumber: 1 },
      book,
    })
    assert.match(out.notes.join(""), /跳过本地清理/)
    assert.deepEqual(closed, [1])
    assert.deepEqual(driver.calls.archive, ["conv-x"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveIssueKey：没带 --issue 的合并按 PR 反查到工单", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-nodes-"))
  const file = path.join(dir, "state.json")
  try {
    const book = new Book(file)
    book.setIssue("demo/demo#121", { state: "pr-open", pr: 122 })
    assert.equal(resolveIssueKey({ runs: [], book, repo: "demo/demo", pr: 122 }), "demo/demo#121")
    // 流程实例优先（run 上记着 PR）
    assert.equal(
      resolveIssueKey({ runs: [{ workflow: "own", key: "demo/demo#121", pr: 122 }], book, repo: "demo/demo", pr: 122 }),
      "demo/demo#121",
    )
    // 对不上就是空，不硬编
    assert.equal(resolveIssueKey({ runs: [], book, repo: "demo/demo", pr: 999 }), "")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
