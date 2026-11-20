import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { OutboxStore, OutboxDispatcher } from "../src/core/outbox.mjs"
import { requestAcceptance, requestOf, acceptanceGate, mailAcceptanceSent, mailAcceptanceFailed } from "../src/mailflow.mjs"
import { Book } from "../src/book.mjs"

function fixture({ maxAttempts = 8 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-mail-outbox-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    outbox: { maxAttempts },
    mail: {
      enabled: true, testers: ["tester-a@corp.test", "tester-b@corp.test"], strategy: "round-robin",
      subjectPrefix: "【foreman 验收】", remindMinutes: 0, maxReminders: 0, uiGate: true,
      uiPatterns: [], allowSenders: [], confirmed: true,
    },
  }
  const store = new OutboxStore(new DatabaseSync(":memory:"))
  const calls = []
  const mail = { async send(message) { calls.push(message); return { queued: true } } }
  const ctx = { cfg, outbox: store, mail, log: () => {} }
  const dispatcher = new OutboxDispatcher({
    store,
    handlers: { mail: (event) => ctx.mail.send(event.payload) },
    onSent: (event) => mailAcceptanceSent(ctx, event),
    onFailed: (event, error) => mailAcceptanceFailed(ctx, event, error),
  })
  return { cfg, store, ctx, dispatcher, calls }
}

test("验收邮件先入 Outbox，Dispatcher 发送成功后才进入 waiting", async () => {
  const { cfg, store, ctx, dispatcher, calls } = fixture()
  const queued = await requestAcceptance(ctx, { repo: "demo/web", pr: 7, url: "http://g/pull/7", title: "改按钮" })
  assert.equal(queued.queued, true)
  assert.equal(calls.length, 0)
  const before = requestOf(new Book(cfg.stateFile), "demo/web", 7)
  assert.equal(before.status, "queued")
  assert.equal(before.pendingOutboxId, queued.outboxId)
  assert.equal(before.sentCount ?? 0, 0)
  assert.equal((await acceptanceGate(ctx, { repo: "demo/web", pr: 7, ui: true })).reason, "acceptance-queued")

  const repeated = await requestAcceptance(ctx, { repo: "demo/web", pr: 7 })
  assert.equal(repeated.skipped, "already-queued")
  assert.equal(store.list().length, 1)

  const result = await dispatcher.runOnce()
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  const after = requestOf(new Book(cfg.stateFile), "demo/web", 7)
  assert.equal(after.status, "waiting")
  assert.equal(after.pendingOutboxId, 0)
  assert.equal(after.sentCount, 1)
  assert.equal(after.lastDeliveredOutboxId, queued.outboxId)
  assert.equal((await acceptanceGate(ctx, { repo: "demo/web", pr: 7, ui: true })).reason, "acceptance-waiting")
})

test("验收邮件最终失败只记 send-failed，不伪装成已发送", async () => {
  const { cfg, store, ctx, dispatcher } = fixture({ maxAttempts: 1 })
  ctx.mail.send = async () => { throw new Error("mail_cli：没授权") }
  const queued = await requestAcceptance(ctx, { repo: "demo/web", pr: 8 })
  const result = await dispatcher.runOnce()
  assert.equal(result.ok, false)
  assert.equal(store.get(queued.outboxId).status, "failed")
  const req = requestOf(new Book(cfg.stateFile), "demo/web", 8)
  assert.equal(req.status, "send-failed")
  assert.equal(req.pendingOutboxId, 0)
  assert.match(req.error, /没授权/)
  assert.equal(req.sentCount ?? 0, 0)
})
