// 通用 workflow：生命周期事件、适配器契约、合并收尾流水线。
import test from "node:test"
import assert from "node:assert/strict"
import { Lifecycle, EVENTS, STAGES } from "../src/workflow/lifecycle.mjs"
import { assertSessionAdapter } from "../src/workflow/adapters/session.mjs"
import { DoubaoSessionAdapter } from "../src/workflow/adapters/doubao.mjs"
import { WorkflowEngine } from "../src/workflow/engine.mjs"

test("生命周期：阶段表覆盖完整链路，事件能映射回阶段", () => {
  const names = STAGES.map((s) => s.stage)
  for (const s of ["pickup", "workspace", "dispatch", "watch", "conclude", "merge", "cleanup", "archive", "notify"]) {
    assert.ok(names.includes(s), `缺阶段 ${s}`)
  }
  assert.equal(EVENTS.merge, "pr.merged")
  assert.equal(EVENTS.archive, "session.archived")
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

test("豆包 adapter：pr.merged 时归档执行会话；workflow.archiveAfterMerge=false 可关", async () => {
  const driver = fakeDriver()
  const a = new DoubaoSessionAdapter({ driver, cfg: {} })
  await a.on("pr.merged", { target: "conv-1" })
  assert.deepEqual(driver.calls.archive, ["conv-1"])
  await a.on("issue.concluded", { target: "conv-2" })
  assert.deepEqual(driver.calls.archive, ["conv-1"], "别的事件不归档")

  const off = new DoubaoSessionAdapter({ driver, cfg: { workflow: { archiveAfterMerge: false } } })
  await off.on("pr.merged", { target: "conv-3" })
  assert.deepEqual(driver.calls.archive, ["conv-1"])
})

test("engine.afterMerge：先清工作区再发 pr.merged，豆包 adapter 随后归档会话", async () => {
  const seq = []
  const driver = fakeDriver()
  const session = new DoubaoSessionAdapter({ driver, cfg: {} })
  const engine = new WorkflowEngine({
    cfg: { repos: [{ repo: "yyzl/win-ai-harness", dir: "/w/harness" }] },
    session,
    tracker: { on: async () => {} },
    workspace: {
      cleanup: async ({ worktree }) => {
        seq.push(`cleanup:${worktree}`)
        return { notes: ["worktree 已删除"] }
      },
      on: async () => {},
    },
    log: () => {},
  })
  const book = { issue: () => ({ worktree: "/wt/fix-issue-268", branch: "fix/issue-268" }) }
  const cleanup = await engine.afterMerge({
    watcher: { target: "conv-exec", issueKey: "yyzl/win-ai-harness#268" },
    merge: { key: "yyzl/win-ai-harness#270", repo: "yyzl/win-ai-harness", pr: 270, issueNumber: 268 },
    book,
  })
  assert.deepEqual(cleanup.notes, ["worktree 已删除"])
  assert.deepEqual(seq, ["cleanup:/wt/fix-issue-268"])
  assert.deepEqual(driver.calls.archive, ["conv-exec"], "归档发生在清理之后")
  const events = engine.lifecycle.history.map((h) => h.event)
  assert.deepEqual(events, ["workspace.cleaned", "pr.merged"])
})

test("engine.afterMerge：没有 worktree 记录时跳过清理，但事件与归档照常", async () => {
  const driver = fakeDriver()
  const engine = new WorkflowEngine({
    cfg: { repos: [] },
    session: new DoubaoSessionAdapter({ driver, cfg: {} }),
    tracker: { on: async () => {} },
    workspace: { cleanup: async () => { throw new Error("不该被调用") }, on: async () => {} },
    log: () => {},
  })
  const cleanup = await engine.afterMerge({
    watcher: { target: "conv-x", issueKey: "r#1" },
    merge: { key: "r#2", repo: "r", pr: 2, issueNumber: 1 },
    book: { issue: () => ({}) },
  })
  assert.match(cleanup.notes.join(""), /跳过本地清理/)
  assert.deepEqual(driver.calls.archive, ["conv-x"])
})
