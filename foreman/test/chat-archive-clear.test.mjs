// chat /clear 与归档：clear 走 routerOnce 轮换（新建会话、旧 convId 进 history），
// archive 归档账本会话（Router 当前会话与子智能体拒绝）；HTTP 路由走 onRpc 通路。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { InboxStore } from "../src/core/inbox.mjs"
import { createChatWorkflow } from "../src/workflow/chat.mjs"
import { Book } from "../src/book.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-chatca-"))
  const stateFile = path.join(dir, "state.json")
  // 预置 router 记录：旧会话 old-conv + 一条普通账本会话 ws-2 + 归档目标 entry 都在账本里。
  fs.writeFileSync(stateFile, JSON.stringify({ router: { convId: "old-conv", name: "foreman-router-old", createdAt: new Date().toISOString() } }))
  const store = new InboxStore(new DatabaseSync(":memory:"))
  const opened = []
  const queued = []
  const archived = []
  const entry = (key, name) => ({ key, name, convId: key, sessionId: key, cwd: "/repo", status: "done", updatedAt: Date.now() })
  const ledger = {
    data: { sessions: { "old-conv": entry("old-conv", "foreman-router-old"), "ws-2": entry("ws-2", "编码会话") } },
    resolve(t) {
      return this.data.sessions[t] ?? null
    },
  }
  const ctx = {
    cfg: { stateFile, router: { recreateAfterHours: 24 } },
    state: { router: { running: false } },
    inbox: store,
    log() {},
    session: {
      ledger,
      async openNew(args) {
        opened.push(args)
        return { convId: "new-conv", name: args.name, background: true }
      },
      async queue(target, text) {
        queued.push({ target, text })
        return { ok: true }
      },
      async archive(target) {
        archived.push(target)
        return { ok: true, stopped: true }
      },
      async info() {
        return { messages: [], running: false }
      },
    },
  }
  ctx.chat = createChatWorkflow(ctx)
  return { dir, stateFile, store, ctx, opened, queued, archived, ledger, chat: ctx.chat }
}

test("/clear：走轮换新建 Router 会话，旧 convId 进 history，后续消息进新会话", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))

  const r = await f.chat.clear()
  assert.equal(r.ok, true)
  assert.equal(r.convId, "new-conv")
  assert.equal(r.previousConvId, "old-conv")
  assert.equal(f.opened.length, 1, "clear 应触发 openNew 新建")
  assert.match(f.opened[0].name, /^foreman-router-/)
  // 新会话首条只有角色 bootstrap，不带巡检与用户文本
  assert.ok(!f.opened[0].prompt.includes("按需巡检"))
  // 账本 router 记录换绑 + 旧会话进 history
  const book = new Book(f.stateFile)
  assert.equal(book.data.router.convId, "new-conv")
  assert.deepEqual(book.data.router.history.map((h) => h.convId), ["old-conv"])
  // 后续消息走 queue 进新会话
  await f.chat.deliver([{ text: "下一句话" }])
  assert.deepEqual(f.queued.map((q) => q.target), ["new-conv"])
})

test("/clear：router 正在跑时拒绝（skipped=busy）", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  f.ctx.state.router.running = true
  await assert.rejects(() => f.chat.clear(), /暂时无法新建 Router 会话/)
  assert.equal(f.opened.length, 0)
})

test("archive：普通账本会话可归档，Router 当前会话与子智能体拒绝", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))

  // Router 当前会话（rec.convId 解析到同一账本条目）拒绝
  await assert.rejects(() => f.chat.archive({ target: "old-conv" }), /Router 当前会话不允许归档/)
  assert.equal(f.archived.length, 0)
  // 子智能体（不在账本）拒绝
  await assert.rejects(() => f.chat.archive({ target: "sess_subagent_x" }), /不归档/)
  // 普通会话放行，按账本 key 归档
  const r = await f.chat.archive({ target: "ws-2" })
  assert.equal(r.ok, true)
  assert.equal(r.archived, "编码会话")
  assert.deepEqual(f.archived, ["ws-2"])
})

test("HTTP：/api/chat/clear 与 /api/chat/archive 走 RPC 通路", async (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  const { handleRequest } = await import("../src/service.mjs")
  const h = await startConsoleHttp({
    store: { polls: () => [], operations: () => [], history: () => ({}) },
    ctx: f.ctx,
    dir: path.join(f.dir, "dist"),
    host: "127.0.0.1",
    port: 0,
    token: "",
    onRpc: (req) => handleRequest(f.ctx, req),
  })
  t.after(() => h.server.close())

  const clear = await fetch(`${h.url}/api/chat/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  const clearBody = await clear.json()
  assert.equal(clear.status, 200)
  assert.equal(clearBody.ok, true)
  assert.equal(clearBody.convId, "new-conv")

  // 归档 router 当前会话（现在是 new-conv？不——clear 后 rec.convId=new-conv 是 openNew 的假 convId，
  // 账本里没有这个 key，resolve 不中 → 不算 router；归档 old-conv 此时应放行）
  const archive = await fetch(`${h.url}/api/chat/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conv: "old-conv" }) })
  const archiveBody = await archive.json()
  assert.equal(archive.status, 200)
  assert.equal(archiveBody.ok, true)
  assert.deepEqual(f.archived, ["old-conv"])

  // 归档不存在的目标 → 400 + 可读错误
  const bad = await fetch(`${h.url}/api/chat/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conv: "nope" }) })
  assert.equal(bad.status, 400)
  const badBody = await bad.json()
  assert.match(badBody.message, /不归档/)
})
