import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AgentWorker, InboxStore } from "../src/core/inbox.mjs"
import { createChatWorkflow } from "../src/workflow/chat.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"
import { handleRequest } from "../src/service.mjs"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-chat-"))
  const store = new InboxStore(new DatabaseSync(":memory:"))
  const opened = []
  const queued = []
  const ctx = {
    cfg: { stateFile: path.join(dir, "state.json"), router: { recreateAfterHours: 24 } },
    state: { router: { running: false } },
    inbox: store,
    log() {},
    dws: {
      async openNew(args) {
        opened.push(args)
        return { convId: "router-1" }
      },
      async queue(target, text) {
        queued.push({ target, text })
        return { ok: true }
      },
      async info() {
        return {
          messages: [
            { id: "u1", role: "user", text: "# Router Agent 职责\n\n【Chat UI 用户消息】\n你好" },
            { id: "a1", role: "assistant", text: "你好，我是 Router Agent", finished: true },
          ],
        }
      },
    },
  }
  ctx.chat = createChatWorkflow(ctx)
  return { dir, store, ctx, opened, queued, chat: ctx.chat }
}

test("Chat 消息先持久化到 Inbox，Worker 消费后才投递 Router Agent", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))

  const accepted = await handleRequest(f.ctx, { cmd: "chat send", text: "帮我检查当前任务", clientId: "browser-message-1" })
  assert.equal(accepted.status, "pending")
  assert.equal(f.store.get(accepted.eventId).kind, "chat.message")
  assert.equal(f.opened.length, 0, "写入 Inbox 时不得直接调用 Router Agent")
  const queuedConversation = await f.chat.messages()
  assert.equal(queuedConversation.pending, 1)
  assert.deepEqual(queuedConversation.pendingMessages.map(({ text, status }) => ({ text, status })), [
    { text: "帮我检查当前任务", status: "pending" },
  ])

  const worker = new AgentWorker({
    store: f.store,
    handlers: { "chat.message": (batch) => f.chat.deliver(batch) },
  })
  const result = await worker.runOnce()
  assert.equal(result.ok, true)
  assert.equal(f.opened.length, 1)
  assert.match(f.opened[0].prompt, /帮我检查当前任务/)
  assert.doesNotMatch(f.opened[0].prompt, /这是首次巡检/)
  assert.equal(f.store.get(accepted.eventId).status, "done")

  const duplicate = await handleRequest(f.ctx, { cmd: "chat send", text: "帮我检查当前任务", clientId: "browser-message-1" })
  assert.equal(duplicate.status, "dropped")
  assert.equal(duplicate.reason, "duplicate")
  await worker.runOnce()
  assert.equal(f.opened.length, 1, "浏览器重试同一 clientId 不得重复投递")
})

test("Chat 读取 Router Agent 会话，并区分用户、回复和 Foreman 事件", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.chat.send({ text: "你好", clientId: "browser-message-2" })
  const worker = new AgentWorker({ store: f.store, handlers: { "chat.message": (batch) => f.chat.deliver(batch) } })
  await worker.runOnce()

  const conversation = await f.chat.messages()
  assert.equal(conversation.convId, "router-1")
  assert.deepEqual(conversation.messages.map((message) => message.role), ["user", "assistant"])
  assert.equal(conversation.messages[0].text, "你好", "首轮提示词不得混入 Chat 用户气泡")
  assert.equal(conversation.messages[1].text, "你好，我是 Router Agent")
  assert.equal(conversation.running, false)
  assert.equal(conversation.pending, 0)
  assert.deepEqual(conversation.pendingMessages, [])
})

test("最后一条是 Foreman 事件时，Chat 仍保持正在回复状态", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.chat.send({ text: "你好", clientId: "browser-message-event" })
  const worker = new AgentWorker({ store: f.store, handlers: { "chat.message": (batch) => f.chat.deliver(batch) } })
  await worker.runOnce()
  f.ctx.dws.info = async () => ({
    messages: [
      { id: "a1", role: "assistant", text: "先收到", finished: false },
      { id: "e1", role: "user", text: "Foreman 事件：任务已更新" },
    ],
  })

  const conversation = await f.chat.messages()
  assert.deepEqual(conversation.messages.map((message) => message.role), ["assistant", "event"])
  assert.equal(conversation.running, true)
})

test("HTTP /api/chat 提供读会话与写入 Inbox 的统一入口", async (t) => {
  const calls = []
  const h = await startConsoleHttp({
    store: {},
    ctx: {},
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "foreman-chat-http-")),
    host: "127.0.0.1",
    port: 0,
    onRpc: async (req) => {
      calls.push(req)
      if (req.cmd === "chat send") return { ok: true, eventId: 7, status: "pending" }
      return { ok: true, convId: "router-1", messages: [], running: false }
    },
  })
  t.after(() => new Promise((resolve) => h.server.close(resolve)))

  const sent = await fetch(`${h.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "你好", clientId: "browser-message-3" }),
  })
  assert.equal(sent.status, 202)
  assert.equal((await sent.json()).eventId, 7)
  const conversation = await (await fetch(`${h.url}/api/chat`, { cache: "no-store" })).json()
  assert.equal(conversation.convId, "router-1")
  assert.deepEqual(calls.map(({ cmd, text, clientId }) => ({ cmd, text, clientId })), [
    { cmd: "chat send", text: "你好", clientId: "browser-message-3" },
    { cmd: "chat messages", text: undefined, clientId: undefined },
  ])
})

test("zcode 账本留痕经 messages() 归一化：派活 prompt 是事件气泡，Chat 用户消息仍认标记", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  // messages() 只读 book.data.router 绑定的会话：先写一条绑定再 mock info。
  const { Book } = await import("../src/book.mjs")
  const book = new Book(f.ctx.cfg.stateFile)
  book.data.router = { convId: "router-1", name: "foreman-router-test" }
  book.save()
  f.ctx.dws.info = async () => ({
    status: "running",
    messages: [
      { role: "user", text: "# Foreman 路由智能体\n\n【Foreman · 接单】工单 demo/demo#1" },
      { role: "assistant", text: "已接单开工" },
      { role: "user", text: "【Chat UI 用户消息】\n现在进展如何" },
    ],
  })

  const conversation = await f.chat.messages()
  assert.deepEqual(conversation.messages.map((m) => m.role), ["event", "assistant", "user"])
  assert.equal(conversation.messages[2].text, "现在进展如何")
  assert.equal(conversation.running, true, "适配器 status=running 时 Chat 保持正在回复")
})

test("messagesFor：按目标会话读（契约归一化），空目标回退 router 当前会话", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  const seen = []
  f.ctx.dws.info = async (target) => {
    seen.push(target)
    return {
      name: `会话-${target}`,
      sessionId: `sess_${target}`,
      running: false,
      messages: [
        { role: "user", text: "派活 prompt 原文" },
        { role: "assistant", text: "干完了" },
      ],
    }
  }

  const coder = await f.chat.messagesFor("zcode-coder-1")
  assert.deepEqual(seen, ["zcode-coder-1"])
  assert.deepEqual(coder.messages.map((m) => m.role), ["event", "assistant"])
  assert.equal(coder.name, "会话-zcode-coder-1")
  assert.equal(coder.pending, 0)

  // 空目标回退 router 当前会话：账本没绑定时返回空会话（不调用 info），绑定后才读。
  const fallback = await f.chat.messagesFor("")
  assert.deepEqual(seen, ["zcode-coder-1"], "router 未绑定时不再读 info")
  assert.equal(fallback.convId, "")
  assert.deepEqual(fallback.messages, [])
  assert.equal(fallback.pending, 0)
})
