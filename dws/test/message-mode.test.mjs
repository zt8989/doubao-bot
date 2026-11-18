// 发消息的两个模式：steer（插进当前这一轮）与 queue（排到这一轮之后）。
// 键位跟配置的默认模式走：默认模式占 Enter，另一个占 Command+Enter。
import test from "node:test"
import assert from "node:assert/strict"
import { Doubao, READ, INPUT_LEN, RUNNING_STATE, keyForMode } from "../src/doubao.mjs"

// 假 page：按脚本是否为已知常量区分调用；记下按了哪些键、带不带 Command 修饰。
function fakePage({ running = {}, inputLen = 0 } = {}) {
  const keys = []
  let sends = 0
  return {
    closed: false,
    keys,
    key: async (k, opts = {}) => {
      keys.push({ key: k, modifiers: opts.modifiers ?? 0 })
      sends += 1
    },
    eval: async (script) => {
      if (script === READ) return { sends, lastSendId: "" }
      if (script === INPUT_LEN) return inputLen
      if (script === RUNNING_STATE) return running
      return 3 // fill()：输入框里放进了 3 个字
    },
  }
}

function mkClient(page, messageMode = "steer") {
  const c = new Doubao({ app: { dataDir: "" }, messageMode, poll: 10 })
  c.page = page
  return c
}

test("keyForMode：默认模式占 Enter，另一个占 Command+Enter", () => {
  assert.equal(keyForMode("steer", "steer"), "enter")
  assert.equal(keyForMode("queue", "steer"), "cmd-enter")
  assert.equal(keyForMode("queue", "queue"), "enter")
  assert.equal(keyForMode("steer", "queue"), "cmd-enter")
  // 缺省与非法值都按 steer 处理
  assert.equal(keyForMode("steer"), "enter")
  assert.equal(keyForMode("nope", "queue"), "cmd-enter")
})

test("message：默认 steer 时 Enter 就是 steer，Command+Enter 才是 queue", async () => {
  const p1 = fakePage()
  const r1 = await mkClient(p1, "steer").message("继续改", { mode: "steer" })
  assert.equal(r1.mode, "steer")
  assert.equal(r1.key, "enter")
  assert.equal(p1.keys.length, 1)
  assert.equal(p1.keys[0].modifiers, 0, "steer 走普通 Enter")

  const p2 = fakePage({ running: { stopBtn: true, interrupt: false }, inputLen: 0 })
  const r2 = await mkClient(p2, "steer").message("排队这条", { mode: "queue" })
  assert.equal(r2.mode, "queue")
  assert.equal(r2.key, "cmd-enter")
  assert.equal(p2.keys[0].modifiers, 4, "queue 走 Command+Enter")
})

test("message：默认模式改成 queue 后键位对调", async () => {
  const p1 = fakePage()
  const r1 = await mkClient(p1, "queue").message("排队", { mode: "queue" })
  assert.equal(r1.key, "enter", "队列模式下 Enter 就是排队")
  assert.equal(p1.keys[0].modifiers, 0)

  const p2 = fakePage({ running: { stopBtn: true, interrupt: false }, inputLen: 0 })
  const r2 = await mkClient(p2, "queue").message("插进去", { mode: "steer" })
  assert.equal(r2.key, "cmd-enter")
  assert.equal(p2.keys[0].modifiers, 4, "队列模式下 steer 改用 Command+Enter")
})

test("排队时不涨消息数也算发出：输入框清空 + 出现排队气泡", async () => {
  const page = fakePage({ running: { stopBtn: true, interrupt: true }, inputLen: 0 })
  const client = mkClient(page, "steer")
  // key 不涨 sends，模拟「排队了这一轮不会进列表」
  page.key = async (k, opts = {}) => {
    page.keys.push({ key: k, modifiers: opts.modifiers ?? 0 })
  }
  const r = await client.message("排队这条", { mode: "queue" })
  assert.equal(r.ok, true)
  assert.equal(r.queued, true)
})

test("长会话虚拟列表：sends 不涨，末条 send 的 message_id 变了也算发出", async () => {
  // 真实场景：会话很长，新消息挤掉一条旧的，[data-testid=send_message] 数量一直不变。
  let sent = false
  const page = {
    closed: false,
    key: async () => { sent = true },
    eval: async (script) => {
      if (script === READ) return { sends: 40, lastSendId: sent ? "m-new" : "m-old" }
      if (script === INPUT_LEN) return 0
      if (script === RUNNING_STATE) return {}
      return 3
    },
  }
  const r = await mkClient(page).message("继续改", { mode: "steer" })
  assert.equal(r.ok, true, "消息其实发了，不能报失败")
  assert.equal(r.sends, 40)
})
