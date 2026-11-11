// 切任务后「URL 已变、消息列表还没换」的回归：那时读到的计数属于上一个会话，
// 拿来当 baseline 会让 dws.send 在消息其实已经送达时报「没有把这条消息发出去」。
// 这里测的是判定用的快照指纹 sigKey + 两个等待策略（用假 page 注入读取序列）。
import test from "node:test"
import assert from "node:assert/strict"
import { sigKey, Doubao } from "../src/doubao.mjs"

const snap = (over = {}) => ({
  convId: "100",
  sends: 1,
  receives: 1,
  lastSendId: "s1",
  lastReceiveId: "r1",
  ...over,
})

// 假 page：每次 eval 按队列顺序返回下一个快照，队列空了就重复最后一个。
function fakePage(queue) {
  let i = 0
  return {
    eval: async () => {
      const v = queue[Math.min(i, queue.length - 1)]
      i++
      return v
    },
  }
}

// 直接调实例上的方法，不连真窗口。
function mkClient() {
  return Object.create(Doubao.prototype)
}

test("sigKey：同一版 DOM 两次读到同一个键，消息数/id 变了就不同", () => {
  assert.equal(sigKey(snap()), sigKey(snap()))
  assert.notEqual(sigKey(snap()), sigKey(snap({ sends: 2, lastSendId: "s2" })))
  assert.equal(sigKey(null), "")
})

test("settleConv：旧会话的计数不当作目标会话（等列表真的换掉）", async () => {
  const client = mkClient()
  // 切过去的过程：第 1 读还是旧会话（sends=30），第 2、3 读换成目标（sends=3，稳定）
  const page = fakePage([
    { convId: "100", sends: 30, receives: 29, lastSendId: "a", lastReceiveId: "b" },
    { convId: "100", sends: 3, receives: 3, lastSendId: "c", lastReceiveId: "d" },
    { convId: "100", sends: 3, receives: 3, lastSendId: "c", lastReceiveId: "d" },
  ])
  const before = snap({ sends: 30, receives: 29, lastSendId: "a", lastReceiveId: "b" })
  const sig = await client.settleConv(page, "100", before, { timeoutMs: 500, pollMs: 0 })
  assert.ok(sig, "等到了稳定快照")
  assert.equal(sig.sends, 3, "拿到的是目标会话的计数，不是旧会话的 30")
})

test("stableCounts：连续两读一致才收，读完还是抖动就用最后读到的那版", async () => {
  const client = mkClient()
  // 一直抖动（每次 id 都变）：不能返回，最终用最后一读
  const shaky = fakePage([snap({ lastReceiveId: "r1" }), snap({ lastReceiveId: "r2" }), snap({ lastReceiveId: "r3" })])
  const sig = await client.stableCounts(shaky, undefined, { pollMs: 0, tries: 3 })
  assert.equal(sig.lastReceiveId, "r3")
})

// 真实踩到的坑：长会话的消息列表是虚拟列表，旁边挤掉一条，sends 条数一直不变，
// 于是「消息其实送到了」被 20 秒判成「没有把这条消息发出去」，通知又被重发一遍。
test("waitReply：条数不变、末条 send 换 id 也算发出去了（虚拟列表）", async () => {
  const client = mkClient()
  client.poll = 1
  client.idleMs = 5000
  client.totalMs = 10000
  const seq = [
    // 刚发完：条数和 id 都还没动
    { sends: 30, receives: 30, lastSendId: "u30", lastReceiveId: "a30" },
    // 消息进来了，但虚拟列表把老消息挤掉一条 → sends 还是 30
    { sends: 30, receives: 30, lastSendId: "u31", lastReceiveId: "a30" },
    // 回复落定
    { sends: 30, receives: 30, lastSendId: "u31", lastReceiveId: "a31", id: "a31", reply: true, finished: true, text: "done", reason: "succeed" },
  ]
  let i = 0
  client.read = async () => seq[Math.min(i++, seq.length - 1)]
  const baseline = { sends: 30, receives: 30, lastSendId: "u30", lastReceiveId: "a30" }
  const r = await client.waitReply({ baseline })
  assert.equal(r.id, "a31")
})

test("waitReply：id 没换就继续等，不把旧回复当新回复", async () => {
  const client = mkClient()
  client.poll = 1
  client.idleMs = 5000
  client.totalMs = 10000
  // 前两读还是旧回复（id 未换），第三读才换
  const seq = [
    { sends: 5, receives: 5, lastSendId: "u6", lastReceiveId: "a5", reply: true, finished: true, text: "old", reason: "succeed" },
    { sends: 5, receives: 5, lastSendId: "u6", lastReceiveId: "a5", reply: true, finished: true, text: "old", reason: "succeed" },
    { sends: 5, receives: 5, lastSendId: "u6", lastReceiveId: "a6", id: "a6", reply: true, finished: true, text: "new", reason: "succeed" },
  ]
  let i = 0
  client.read = async () => seq[Math.min(i++, seq.length - 1)]
  const baseline = { sends: 5, receives: 5, lastSendId: "u5", lastReceiveId: "a5" }
  const r = await client.waitReply({ baseline })
  assert.equal(r.text, "new")
})

