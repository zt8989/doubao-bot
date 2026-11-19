import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { InboxStore, AgentWorker } from "../src/inbox.mjs"
import { mailPollOnce, deliverMailReply } from "../src/mailflow.mjs"
import { Book } from "../src/book.mjs"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-mail-route-"))
}

test("普通邮件回复入 Inbox，Worker steer 命中会话，其余交给 router agent", async () => {
  const dir = tempDir()
  const store = new InboxStore(new DatabaseSync(":memory:"))
  const steered = []
  const queued = []
  const opened = []
  const messages = [
    { message_id: "m-hit", subject: "Re: 发布 [FM-SID:conv-hit]", from: { email: "owner@corp.test" }, created_at: "2026-11-19T08:00:00Z" },
    { message_id: "m-missing", subject: "Re: 发布 [FM-SID:conv-missing]", from: { email: "owner@corp.test" }, created_at: "2026-11-19T08:01:00Z" },
    { message_id: "m-router", subject: "没有路由标记", from: { email: "owner@corp.test" }, created_at: "2026-11-19T08:02:00Z" },
  ]
  const ctx = {
    cfg: {
      stateFile: path.join(dir, "state.json"),
      mail: { enabled: true, testers: [] },
      router: { enabled: true, recreateAfterHours: 24 },
      pickup: { maxRunning: 2 },
      deliver: { namePrefix: "foreman" },
    },
    state: {},
    inbox: store,
    log: () => {},
    mail: {
      list: async () => ({ data: messages }),
      read: async (id) => ({ body: `<p>回复 ${id}</p>`, from: messages.find((m) => m.message_id === id).from }),
    },
    dws: {
      info: async (id) => id === "conv-hit" ? { convId: id } : null,
      steer: async (id, text) => steered.push({ id, text }),
      openNew: async ({ name, prompt }) => {
        opened.push({ name, prompt })
        return { convId: "conv-router" }
      },
      queue: async (id, text) => queued.push({ id, text }),
    },
  }
  try {
    const polled = await mailPollOnce(ctx, { force: true })
    assert.equal(polled.routed, 3)
    assert.equal(store.counts().pending, 3)
    const events = store.list({ kind: "mail.reply" })
    const byMessage = new Map(events.map((event) => [event.payload.messageId, event]))
    assert.deepEqual(events.map((event) => event.payload.sessionId).sort(), ["", "conv-hit", "conv-missing"])
    assert.match(byMessage.get("m-hit").text, /回复 m-hit/)
    assert.doesNotMatch(byMessage.get("m-hit").text, /<p>/)

    const worker = new AgentWorker({
      store,
      handlers: { "mail.reply": (event) => deliverMailReply(ctx, event) },
      log: () => {},
    })
    const delivered = await worker.runOnce()
    assert.equal(delivered.ok, true)
    assert.equal(delivered.completed, 3)
    assert.deepEqual(steered.map((item) => item.id), ["conv-hit"])
    assert.equal(opened.length, 1)
    assert.deepEqual(queued.map((item) => item.id), ["conv-router"])
    const fallbackText = [...opened.map((item) => item.prompt), ...queued.map((item) => item.text)].join("\n")
    assert.match(fallbackText, /回复 m-router/)
    assert.match(fallbackText, /conv-missing 未命中/)
    assert.equal(store.counts().done, 3)
    assert.equal(Object.keys(new Book(ctx.cfg.stateFile).mail.seen).length, 3)

    const again = await mailPollOnce(ctx, { force: true })
    assert.equal(again.routed, 0)
    assert.equal(store.counts().done, 3)
  } finally {
    store.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("DWS 临时故障保留邮件事件重试，不错误改投 router", async () => {
  const dir = tempDir()
  const store = new InboxStore(new DatabaseSync(":memory:"))
  store.enqueue({ kind: "mail.reply", text: "reply", payload: { sessionId: "conv-hit", messageId: "m-retry" }, dedupeKey: "m-retry" })
  const ctx = {
    cfg: { stateFile: path.join(dir, "state.json") },
    dws: { info: async () => ({ ok: false, error: "app_busy" }) },
  }
  try {
    const worker = new AgentWorker({ store, handlers: { "mail.reply": (event) => deliverMailReply(ctx, event) }, log: () => {} })
    const result = await worker.runOnce()
    assert.equal(result.ok, false)
    assert.equal(store.counts().pending, 1)
    assert.match(store.list({ status: "pending" })[0].lastError, /app_busy/)
  } finally {
    store.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
