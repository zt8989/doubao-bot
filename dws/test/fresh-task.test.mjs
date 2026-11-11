// isFreshTask 是记账层的守卫：点完「新建工作任务」后，回读到的会话 id 必须与
// 点之前所在的会话 id 不同。这正是 foreman-250 事故的回归——新任务其实建出来了，
// 但回读错成了用户当前会话，state.json 因此落了一条假 convId。
import test from "node:test"
import assert from "node:assert/strict"
import { isFreshTask } from "../src/util.mjs"

test("点前后 convId 相同 → false（根本没离开旧会话，事故主场景）", () => {
  // foreman-250 事故：新建前在 38453052825833730，回读还是这个 id
  assert.equal(isFreshTask("38453052825833730", "38453052825833730", { requireNewId: true }), false)
})

test("convId 变了，但停在新 /chat 页还没发消息（无 id）→ true（不带 prompt 时合法）", () => {
  assert.equal(isFreshTask("38453052825833730", ""), true)
})

test("convId 变了且拿到具体新 id → true", () => {
  assert.equal(isFreshTask("38453052825833730", "38453027807982594", { requireNewId: true }), true)
})

test("发完首条消息回读时却拿到空 id → false（记账层不允许落一条空 convId）", () => {
  assert.equal(isFreshTask("38453052825833730", "", { requireNewId: true }), false)
})

test("点之前 convId 为空/解析失败 → false（不知道从哪点的，无法判定变化）", () => {
  assert.equal(isFreshTask("", "38453027807982594", { requireNewId: true }), false)
  assert.equal(isFreshTask(null, "38453027807982594"), false)
  assert.equal(isFreshTask("not-a-number", "38453027807982594"), false)
})

test("新建流程成功、但回读落到了旧会话 → 必须判 false，不许记账成功", () => {
  // 关键回归：NEW_TASK 可能返回成功、消息也可能发出去了，但 waitReply 读到的是旧会话
  const before = "38453052825833730"
  const readback = "38453052825833730"
  assert.equal(isFreshTask(before, readback, { requireNewId: true }), false)
})
