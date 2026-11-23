import test from "node:test"
import assert from "node:assert/strict"
import { normalizeSessionMessages, normalizeRunning } from "../src/workflow/adapters/session.mjs"

test("normalizeSessionMessages：Chat 标记 → user 气泡；assistant 保留；其余一律 event", () => {
  const out = normalizeSessionMessages([
    { role: "user", text: "# Foreman 路由智能体\n\n【Foreman · 接单】工单 demo/demo#1" },
    { role: "assistant", text: "已接单开工" },
    { role: "user", text: "前缀【Chat UI 用户消息】\n现在进展如何" },
    { text: "没有 role 的 Foreman 事件" },
  ])
  assert.deepEqual(out.map((m) => m.role), ["event", "assistant", "user", "event"])
  assert.equal(out[2].text, "现在进展如何")
  assert.equal(out[0].text.includes("Foreman 路由智能体"), true, "event 保留原文")
  assert.deepEqual(out.map((m) => m.finished), [true, true, true, true])
  assert.deepEqual(out.map((m) => m.id), ["0", "1", "2", "3"])
})

test("normalizeSessionMessages：finished/error 透传；非数组安全回空", () => {
  const out = normalizeSessionMessages([{ role: "assistant", text: "还没回完", finished: false, error: "超时" }])
  assert.equal(out[0].finished, false)
  assert.equal(out[0].error, "超时")
  assert.deepEqual(normalizeSessionMessages(undefined), [])
  assert.deepEqual(normalizeSessionMessages(null), [])
})

test("normalizeRunning：显式 running 优先；否则尾部不是已完成 assistant 就算在跑", () => {
  assert.equal(normalizeRunning({ running: true, messages: [] }), true)
  assert.equal(normalizeRunning({ running: false, messages: [{ role: "user", text: "x" }] }), false)
  // 没显式给：尾部 user 派活 prompt = 在跑
  assert.equal(normalizeRunning({ messages: [{ role: "user", text: "派活" }] }), true)
  // 尾部已完成 assistant = 不在跑
  assert.equal(normalizeRunning({ messages: [{ role: "assistant", text: "回完了", finished: true }] }), false)
  // 尾部 assistant 但未完成 = 在跑
  assert.equal(normalizeRunning({ messages: [{ role: "assistant", text: "…", finished: false }] }), true)
  // 空 = 不在跑
  assert.equal(normalizeRunning({}), false)
})
