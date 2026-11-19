import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConsoleStore } from "../src/console.mjs"

const tmpStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-console-"))
  return new ConsoleStore(path.join(dir, "console.db"))
}

test("按工单号去重：同一张单重复同步不多出行，first_seen 保留", () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  const book = {
    issues: { "yyzl/win-ai-harness#250": { title: "改 A", state: "working", updatedAt: now } },
    prSeen: { "yyzl/win-ai-harness#260": { author: "233151", skipped: "self", seenAt: now } },
  }

  const s1 = store.sync(book)
  assert.equal(s1.newTasks, 1)
  assert.equal(s1.totalTasks, 1)
  assert.equal(s1.newPrs, 1)

  const s2 = store.sync(book)
  assert.equal(s2.newTasks, 0, "第二轮不应新增工单")
  assert.equal(s2.newPrs, 0, "第二轮不应新增 PR")
  assert.equal(s2.totalTasks, 1)
  assert.equal(s2.totalPrs, 1)

  const snap = store.snapshot({ book, cfg: { repos: [], prWatch: {} }, pr: {} })
  assert.equal(snap.tasks.length, 1)
  assert.equal(snap.prs.length, 1)
  assert.equal(snap.prs[0].state, "skipped")
  assert.equal(snap.storage.rows.tasks, 1)
  assert.equal(snap.storage.uniqueKey, "<owner>/<repo>#<number>")
  store.close()
})

test("PR 状态映射：待通知 / 已通知 / 跳过", () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  const book = {
    issues: {},
    prSeen: {
      "a/b#1": { author: "other", seenAt: now },
      "a/b#2": { author: "other", seenAt: now, notifiedTo: "conv-1", notifiedAt: now },
      "a/b#3": { author: "233151", skipped: "self", seenAt: now },
    },
  }
  const s = store.sync(book)
  assert.equal(s.newPrs, 3)

  const snap = store.snapshot({ book, cfg: { prWatch: { enabled: true, intervalSeconds: 300 } }, pr: {} })
  const byKey = Object.fromEntries(snap.prs.map((p) => [p.key, p]))
  assert.equal(byKey["a/b#1"].state, "pending")
  assert.equal(byKey["a/b#1"].pending, true)
  assert.equal(byKey["a/b#2"].state, "notified")
  assert.equal(byKey["a/b#2"].notifiedTo, "conv-1")
  assert.equal(byKey["a/b#3"].state, "skipped")
  assert.equal(snap.stats.pending, 1)
  assert.equal(snap.stats.notified, 1)
  assert.equal(snap.stats.skipped, 1)
  store.close()
})

test("polls 记录每轮扫描，且条数随轮次增长", () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  const book = {
    issues: { "a/b#1": { title: "t", state: "working", updatedAt: now } },
    prSeen: { "a/b#2": { author: "x", seenAt: now } },
  }
  const s = store.sync(book)
  store.recordPoll(s)
  store.recordPoll(store.sync(book))

  const snap = store.snapshot({ book, cfg: {}, pr: {} })
  assert.equal(snap.storage.rows.polls, 2)
  assert.equal(snap.recentPolls.length, 2)
  assert.equal(snap.recentPolls[0].tasks, 1)
  assert.equal(snap.recentPolls[0].newTasks, 0, "第二轮没有新增")
  store.close()
})

test("今日任务先按状态排序，进行中优先，同状态按最后更新时间倒序", () => {
  const store = tmpStore()
  const now = Date.now()
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString()
  const book = {
    issues: {
      "a/b#1": { title: "刚完成", state: "done", updatedAt: at(1) },
      "a/b#2": { title: "较早进行中", state: "working", updatedAt: at(30) },
      "a/b#3": { title: "已计划", state: "planned", updatedAt: at(20) },
      "a/b#4": { title: "最近进行中", state: "working", updatedAt: at(10) },
      "a/b#5": { title: "已出 PR", state: "pr-open", updatedAt: at(5) },
    },
    prSeen: {},
  }

  store.sync(book)
  const snap = store.snapshot({ book, cfg: {}, pr: {} })
  assert.deepEqual(snap.tasks.map((t) => t.key), ["a/b#4", "a/b#2", "a/b#3", "a/b#5", "a/b#1"])
  store.close()
})

test("进行中统计只算执行会话仍在跑的工单，不把待收口账本行算进去", () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  const book = {
    issues: {
      "a/b#1": { title: "实际在跑", state: "working", agentConvId: "conv-live", updatedAt: now },
      "a/b#2": { title: "会话已停", state: "working", agentConvId: "conv-idle", updatedAt: now },
      "a/b#3": { title: "仅编排未派执行", state: "working", agentConvId: "", updatedAt: now },
    },
    prSeen: {},
  }

  store.sync(book)
  const snap = store.snapshot({
    book,
    cfg: {},
    pr: {},
    runningSessions: {
      "conv-live": { running: true },
      "conv-idle": { running: false },
    },
  })
  assert.equal(snap.stats.working, 1)
  assert.deepEqual(snap.tasks.filter((t) => t.running).map((t) => t.key), ["a/b#1"])
  store.close()
})

test("今日口径按真实变化时间：账本没变的老单不会因为同步被算进今天", () => {
  const store = tmpStore()
  const old = new Date(Date.now() - 3 * 86400000).toISOString()
  const book = { issues: { "a/b#1": { title: "老单", state: "done", updatedAt: old } }, prSeen: {} }

  store.sync(book)
  store.sync(book) // 再同步一轮，last_seen_at 会刷新，但 last_change_at 不能动
  const snap = store.snapshot({ book, cfg: {}, pr: {} })
  assert.equal(snap.tasks.length, 0, "三天前的单不该出现在今天")
  assert.equal(snap.storage.rows.tasks, 1, "库里仍然留着它，只是不算今天")
  assert.equal(snap.stats.historyTasks, 1)

  store.recordPoll(store.sync(book))
  assert.equal(store.snapshot({ book, cfg: {}, pr: {} }).recentPolls[0].tasks, 0, "轮询口径同样不算老单")

  const now = new Date().toISOString()
  const book2 = { issues: { ...book.issues, "a/b#2": { title: "新单", state: "working", updatedAt: now } }, prSeen: {} }
  store.sync(book2)
  const snap2 = store.snapshot({ book: book2, cfg: {}, pr: {} })
  assert.equal(snap2.tasks.length, 1, "今天新派的单要出现，且只有它")
  assert.equal(snap2.tasks[0].key, "a/b#2")
  store.close()
})
