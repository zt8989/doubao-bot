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
