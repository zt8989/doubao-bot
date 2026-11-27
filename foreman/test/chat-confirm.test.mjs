// 聊天消息投递确认：转录出现消息才算成功，超时回 Inbox 重试。
import test from "node:test"
import assert from "node:assert/strict"
import { confirmChatDelivered } from "../src/service.mjs"

const EVENTS = [{ text: "创建工单 知识库话术改成如下" }]
const now = Date.now()
const instant = (ms) => (ms) => new Promise((r) => setTimeout(r, 1))

function fixture({ rows = [], carrier = "zcode", okFlag = true, throwErr = null, base = null } = {}) {
  const polls = []
  const stream = {
    transcript: async () => {
      polls.push(1)
      if (throwErr) throw throwErr
      if (!okFlag) return { ok: false, carrier: "dws" }
      return { ok: true, carrier, conv: "router-1", rows, cursor: rows.length }
    },
  }
  const baseCalls = []
  const ctx = {
    log: () => {},
    chat: { messagesBase: async () => { baseCalls.push(1); return base } },
  }
  return { ctx, stream, polls, baseCalls }
}

test("确认成功：新增 user 消息含归一化前缀即通过", async () => {
  const { ctx, stream, polls } = fixture({
    rows: [
      { kind: "message", id: "u1", role: "user" },
      { kind: "part", messageId: "u1", type: "text", text: "【Chat UI 用户消息】\n创建工单 知识库话术改成如下：您好！…" },
    ],
  })
  await confirmChatDelivered(ctx, EVENTS, now, { stream, timeoutMs: 5000, pollMs: 1, sleep: instant })
  assert.equal(polls.length, 1, "第一轮命中即返回")
})

test("确认成功：transcript 直读炸了回落 messagesBase", async () => {
  const { ctx, stream, baseCalls, polls } = fixture({
    throwErr: new Error("db locked"),
    base: { messages: [{ role: "user", text: "【Chat UI 用户消息】创建工单 知识库话术改成如下" }] },
  })
  await confirmChatDelivered(ctx, EVENTS, now, { stream, timeoutMs: 5000, pollMs: 1, sleep: instant })
  assert.ok(baseCalls.length >= 1, "走了账本回落")
  assert.ok(polls.length >= 1)
})

test("确认成功：非 zcode 载体（ok:false）走账本回落", async () => {
  const { ctx, stream, baseCalls } = fixture({
    okFlag: false,
    base: { messages: [{ role: "user", text: "创建工单 知识库话术改成如下" }] },
  })
  await confirmChatDelivered(ctx, EVENTS, now, { stream, timeoutMs: 5000, pollMs: 1, sleep: instant })
  assert.ok(baseCalls.length >= 1)
})

test("确认失败：超时未出现 → 抛错（事件回 Inbox 重试）", async () => {
  const { ctx, stream } = fixture({ rows: [] })
  await assert.rejects(
    () => confirmChatDelivered(ctx, EVENTS, now, { stream, timeoutMs: 30, pollMs: 5, sleep: instant }),
    /投递确认失败/,
  )
})

test("空事件直接通过；消息文本归一化（空白折叠）后比对", async () => {
  const { ctx, stream } = fixture({
    rows: [
      { kind: "message", id: "u1", role: "user" },
      { kind: "part", messageId: "u1", type: "text", text: "【Chat UI 用户消息】创建工单\n知识库话术 改成如下" },
    ],
  })
  await confirmChatDelivered(ctx, [], now, { stream, timeoutMs: 100, pollMs: 1, sleep: instant })
  await confirmChatDelivered(ctx, [{ text: "创建工单\n知识库话术 改成如下" }], now, { stream, timeoutMs: 3000, pollMs: 1, sleep: instant })
})
