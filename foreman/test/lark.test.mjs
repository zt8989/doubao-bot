import test from "node:test"
import assert from "node:assert/strict"
import { LarkDriver } from "../src/lark.mjs"

test("lark-cli 文本外发使用用户身份和稳定幂等键", async () => {
  const calls = []
  const driver = new LarkDriver({
    execFn: async (bin, args) => {
      calls.push({ bin, args })
      return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_1", chat_id: "oc_1" } }) }
    },
  })
  const result = await driver.send({ chatId: "oc_1", text: "发布完成", idempotencyKey: "fm-event-1" })
  assert.equal(result.message_id, "om_1")
  assert.deepEqual(calls[0], {
    bin: "lark-cli",
    args: ["im", "+messages-send", "--chat-id", "oc_1", "--text", "发布完成", "--as", "user", "--idempotency-key", "fm-event-1"],
  })
})

test("lark-cli Markdown 可私聊发送，目标与正文参数严格互斥", async () => {
  const calls = []
  const driver = new LarkDriver({
    execFn: async (_bin, args) => {
      calls.push(args)
      return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_2" } }) }
    },
  })
  await driver.send({ userId: "ou_1", markdown: "## 完成\n\n- 已发布" })
  assert.deepEqual(calls[0].slice(0, 6), ["im", "+messages-send", "--user-id", "ou_1", "--markdown", "## 完成\n\n- 已发布"])
  await assert.rejects(() => driver.send({ chatId: "oc_1", userId: "ou_1", text: "x" }), /只能提供一个/)
  await assert.rejects(() => driver.send({ chatId: "oc_1", text: "x", markdown: "y" }), /只能提供一个/)
  assert.equal(calls.length, 1)
})

test("lark-cli 非零退出和 ok:false 都不会被当成已发送", async () => {
  const failedProcess = new LarkDriver({ execFn: async () => { throw new Error("permission denied") } })
  await assert.rejects(() => failedProcess.send({ chatId: "oc_1", text: "x" }), /permission denied/)
  const failedApi = new LarkDriver({ execFn: async () => ({ stdout: JSON.stringify({ ok: false, error: { message: "no scope" } }) }) })
  await assert.rejects(() => failedApi.send({ chatId: "oc_1", text: "x" }), /no scope/)
})
