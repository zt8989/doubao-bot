import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionBook, SessionManager, matchTask } from "../src/sessions.mjs"
import { selfConvIds } from "../src/util.mjs"

const tasks = [
  { id: "38453052825833730", title: "委派Gitea工单" },
  { id: "38452709939491842", title: "本地Linux沙盒模式实现" },
  { id: "38453099753059330", title: "接工单 yyzl/win-ai-harness#245 处理要求" },
  { id: "38453099753059331", title: "接工单 yyzl/win-ai-harness#246 处理要求" },
]

test("按标题精确匹配到任务 id", () => {
  assert.equal(matchTask(tasks, "委派Gitea工单").id, "38453052825833730")
})

test("标题唯一包含也能匹配", () => {
  assert.equal(matchTask(tasks, "沙盒").id, "38452709939491842")
})

test("包含匹配命中多条时不猜，返回 null", () => {
  assert.equal(matchTask(tasks, "接工单"), null)
})

test("找不到返回 null", () => {
  assert.equal(matchTask(tasks, "不存在的会话"), null)
})

test("空标题与空列表都返回 null", () => {
  assert.equal(matchTask(tasks, ""), null)
  assert.equal(matchTask([], "委派Gitea工单"), null)
})

test("没有 title 字段的任务不会误命中", () => {
  assert.equal(matchTask([{ id: "12345678" }], "委派Gitea工单"), null)
})

test("从环境里认出发命令的会话自己", () => {
  assert.deepEqual(selfConvIds({ MCP_VM_CONVERSATION_ID: "38453052825833730" }), ["38453052825833730"])
})

test("环境变量缺失或格式不对时返回空列表，不做自我拦截", () => {
  assert.deepEqual(selfConvIds({}), [])
  assert.deepEqual(selfConvIds({ MCP_VM_CONVERSATION_ID: "abc" }), [])
})

test("多个来源都给 id 时按顺序都收下", () => {
  assert.deepEqual(
    selfConvIds({ DWS_SELF_CONV_ID: "12345678", MCP_VM_CONVERSATION_ID: "23456789" }),
    ["12345678", "23456789"]
  )
})

function statusFixture(t, records, { running = false, cachedReply = null, partialTail = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dws-status-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const convId = "38455109344616706"
  const traceDir = path.join(
    root,
    "profile",
    "Default",
    ".doubao",
    "agent_mode",
    "workspace",
    ".sessions",
    convId,
    "agents",
    "m_test",
    "system"
  )
  fs.mkdirSync(traceDir, { recursive: true })
  fs.writeFileSync(
    path.join(traceDir, "trajectory.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "") + partialTail
  )
  const book = new SessionBook(path.join(root, "state.json"))
  book.record("demo", { convId, ...(cachedReply ? { reply: cachedReply } : {}) })
  let gotoCalls = 0
  let readCalls = 0
  const doubao = {
    app: { dataDir: root },
    tasks: async () => [{ id: convId, running }],
    goto: async () => {
      gotoCalls++
    },
    read: async () => {
      readCalls++
    },
  }
  return {
    root,
    convId,
    session: new SessionManager({ book, doubao }),
    calls: () => ({ gotoCalls, readCalls }),
  }
}

test("status 从 JSONL 读最终回复，不 goto 也不读当前页面", async (t) => {
  const f = statusFixture(
    t,
    [
      { role: "user", content: "处理一下" },
      { role: "assistant", content: "已经处理完成" },
    ],
    { partialTail: '{"role":"assistant","content":"正在写入的半行' }
  )
  const r = await f.session.convStatus(f.convId)
  assert.equal(r.finished, true)
  assert.equal(r.streaming, false)
  assert.equal(r.head, "已经处理完成")
  assert.equal(r.chars, 6)
  assert.equal(r.source, "sidebar+jsonl")
  assert.deepEqual(f.calls(), { gotoCalls: 0, readCalls: 0 })
})

test("status 用侧边栏 running 覆盖未完成的 JSONL 轨迹", async (t) => {
  const f = statusFixture(
    t,
    [
      { role: "user", content: "继续" },
      {
        role: "assistant",
        content: "正在检查",
        tool_calls: [{ id: "call-1", function: { name: "Bash", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", tool_call_id: "call-1" },
    ],
    { running: true }
  )
  const r = await f.session.status("demo")
  assert.equal(r.live, true)
  assert.equal(r.reply.streaming, true)
  assert.equal(r.reply.finished, false)
  assert.equal(r.reply.head, "正在检查")
  assert.deepEqual(f.calls(), { gotoCalls: 0, readCalls: 0 })
})

test("新一轮没有最终回复时不沿用 state 里的已完成状态", async (t) => {
  const f = statusFixture(
    t,
    [
      { role: "assistant", content: "上一轮完成" },
      { role: "user", content: "再做一件事" },
      { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "call-1" },
    ],
    {
      cachedReply: { finished: true, chars: 6, head: "上一轮完成", status: "Success" },
    }
  )
  const r = await f.session.convStatus(f.convId)
  assert.equal(r.finished, false)
  assert.equal(r.streaming, false)
  assert.equal(r.status, "")
})

test("没有 JSONL 时保留 state 摘要回退", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dws-status-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const convId = "38455109344616706"
  const book = new SessionBook(path.join(root, "state.json"))
  book.record("demo", {
    convId,
    reply: { finished: true, chars: 2, head: "完成", tail: "完成", status: "Success" },
  })
  let gotoCalls = 0
  const doubao = {
    app: { dataDir: root },
    tasks: async () => [{ id: convId, running: false }],
    goto: async () => {
      gotoCalls++
    },
  }
  const r = await new SessionManager({ book, doubao }).convStatus(convId)
  assert.equal(r.finished, true)
  assert.equal(r.head, "完成")
  assert.equal(r.source, "sidebar+state")
  assert.equal(gotoCalls, 0)
})
