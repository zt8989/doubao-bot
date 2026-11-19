import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { InboxStore } from "../src/inbox.mjs"
import { Book } from "../src/book.mjs"
import { enqueueTaskUpdate, deliverTaskUpdate, taskOwner } from "../src/taskevents.mjs"

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-task-events-"))
  const db = new DatabaseSync(path.join(dir, "console.db"))
  const cfg = { stateFile: path.join(dir, "state.json"), service: { http: { db: path.join(dir, "console.db") } } }
  const book = new Book(cfg.stateFile)
  const inbox = new InboxStore(db)
  return { dir, cfg, book, inbox, db }
}

test("task.update 入箱保留最终回复并按工单所属编排路由；Worker 送达后才休眠任务", async () => {
  const { dir, cfg, book, inbox } = setup()
  try {
    book.setIssue("demo/demo#7", { state: "working", orchestrator: "conv-orch" })
    const watcher = { target: "conv-worker", name: "worker", issueKey: "demo/demo#7", repo: "demo/demo", number: 7 }
    const queued = []
    const ctx = { cfg, book, inbox, dws: { queue: async (target, text) => queued.push({ target, text }) } }
    const enqueued = enqueueTaskUpdate(ctx, {
      watcher,
      phase: "finished",
      fingerprint: "abc123",
      finalText: "已修改并提交；npm test 通过。",
      observedAt: new Date("2026-11-19T01:00:00Z"),
    })
    assert.equal(enqueued.ok, true)
    assert.equal(enqueued.owner, "conv-orch")
    assert.equal(book.notified["conv-worker"], undefined, "仅入箱不能提前消费任务指纹")
    assert.equal(queued.length, 0, "Schedule/poll 不直接给 Agent 发消息")

    const [event] = inbox.claimBatch(new Date("2026-11-19T01:02:00Z"))
    assert.equal(event.kind, "task.update")
    assert.equal(event.payload.issueKey, "demo/demo#7")
    assert.equal(event.payload.finalText, "已修改并提交；npm test 通过。")
    assert.doesNotMatch(event.text, /自动 push|自动开 PR|<RESULT>/)
    await deliverTaskUpdate(ctx, event)
    inbox.complete(event.id)

    assert.equal(queued.length, 1)
    assert.equal(queued[0].target, "conv-orch")
    assert.match(queued[0].text, /最终回复原文/)
    assert.match(queued[0].text, /已修改并提交；npm test 通过。/)
    const after = new Book(cfg.stateFile).notified["conv-worker"]
    assert.equal(after.fingerprint, "abc123")
    assert.equal(after.idle, true)
  } finally {
    inbox.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("同一任务 pending 更新合并为最新状态，不制造一串过时投递", () => {
  const { dir, cfg, book, inbox } = setup()
  try {
    book.setIssue("demo/demo#7", { orchestrator: "conv-orch" })
    const watcher = { target: "conv-worker", name: "worker", issueKey: "demo/demo#7" }
    const ctx = { cfg, book, inbox }
    enqueueTaskUpdate(ctx, { watcher, phase: "running", observedAt: new Date("2026-11-19T01:00:00Z") })
    enqueueTaskUpdate(ctx, { watcher, phase: "finished", fingerprint: "new-final", finalText: "最终结果", observedAt: new Date("2026-11-19T01:01:00Z") })
    const events = inbox.list({ status: "pending" })
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.phase, "finished")
    assert.equal(events[0].payload.finalText, "最终结果")
  } finally {
    inbox.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("补派监听优先回 parent；完全无编排的旧任务回退检查智能体", () => {
  const { dir, book, inbox } = setup()
  try {
    book.record("worker", { parent: "conv-parent" })
    assert.deepEqual(taskOwner(book, { target: "w", name: "worker" }), { owner: "conv-parent", viaInspector: false })
    book.data.inspector = { convId: "conv-inspector" }
    assert.deepEqual(taskOwner(book, { target: "orphan", name: "orphan" }), { owner: "conv-inspector", viaInspector: true })
  } finally {
    inbox.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("回退检查智能体投递失败必须抛错，不能消费任务更新", async () => {
  const { dir, cfg, book, inbox } = setup()
  try {
    book.data.inspector = { convId: "conv-inspector", name: "inspector" }
    book.data.sessions = { inspector: { convId: "conv-inspector", name: "inspector", kind: "inspector" } }
    book.save()
    const event = {
      id: "task-orphan-finished",
      payload: {
        taskId: "orphan",
        taskName: "orphan",
        owner: "conv-inspector",
        viaInspector: true,
        phase: "finished",
        fingerprint: "final-1",
        finalText: "普通最终回复",
        observedAt: "2026-11-19T01:00:00.000Z",
      },
    }
    const ctx = {
      cfg,
      book,
      inbox,
      state: {},
      dws: {
        queue: async () => { throw new Error("queue failed") },
        openNew: async () => { throw new Error("不应新建") },
      },
    }
    await assert.rejects(deliverTaskUpdate(ctx, event), /queue failed/)
    assert.equal(book.notified.orphan, undefined)
  } finally {
    inbox.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
