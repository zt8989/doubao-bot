import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { OutboxStore } from "../src/outbox.mjs"
import { enqueueOutbound, outboundPayload } from "../src/outbound.mjs"

test("统一 send 校验 mail/lark 参数，不提供 lark send 独立通道", () => {
  assert.deepEqual(outboundPayload("mail", { to: "a@corp.test,b@corp.test", subject: "发布", body: "完成" }), {
    channel: "mail", payload: { to: ["a@corp.test", "b@corp.test"], subject: "发布", body: "完成" },
  })
  assert.deepEqual(outboundPayload("lark", { userId: "ou_1", markdown: "## 完成" }), {
    channel: "lark", payload: { chatId: "", userId: "ou_1", markdown: "## 完成" },
  })
  assert.throws(() => outboundPayload("", {}), /--type mail\|lark/)
  assert.throws(() => outboundPayload("gitea", {}), /--type mail\|lark/)
  assert.throws(() => outboundPayload("lark", { chatId: "oc_1", userId: "ou_1", text: "x" }), /只能提供一个/)
})

test("邮件主题自动携带可路由的会话 ID", () => {
  const result = outboundPayload("mail", { to: "a@corp.test", subject: "发布", sessionId: "conv-123" })
  assert.equal(result.payload.subject, "发布 [FM-SID:conv-123]")
  assert.equal(result.payload.sessionId, "conv-123")
  assert.throws(() => outboundPayload("mail", { to: "a@corp.test", subject: "发布", sessionId: "bad id" }), /session-id/)
})

test("统一 send 只写 Outbox，dedupeKey 防止重复入队", () => {
  const store = new OutboxStore(new DatabaseSync(":memory:"))
  const ctx = { outbox: store, cfg: { outbox: { maxAttempts: 8 } } }
  const first = enqueueOutbound(ctx, { type: "lark", input: { chatId: "oc_1", text: "完成" }, dedupeKey: "manual-1" })
  const duplicate = enqueueOutbound(ctx, { type: "lark", input: { chatId: "oc_1", text: "完成" }, dedupeKey: "manual-1" })
  assert.equal(first.status, "pending")
  assert.equal(first.type, "lark")
  assert.equal(duplicate.id, first.id)
  assert.equal(duplicate.duplicate, true)
  assert.equal(store.list().length, 1)
  assert.deepEqual(store.get(first.id).payload, { chatId: "oc_1", userId: "", text: "完成" })
})
