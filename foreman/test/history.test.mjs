import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConsoleStore } from "../src/console.mjs"

const tmpStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-history-"))
  return new ConsoleStore(path.join(dir, "console.db"))
}

const KEY = "yyzl/win-ai-harness#250"

test("首次同步记 task_new，状态推进记 task_state（带 from/to）", () => {
  const store = tmpStore()

  store.sync({ issues: { [KEY]: { title: "改 A", state: "working" } }, prSeen: {} })
  let h = store.history({ days: 0 })
  assert.equal(h.total, 1)
  assert.equal(h.groups.length, 1)
  assert.equal(h.groups[0].items[0].kind, "task_new")
  assert.equal(h.groups[0].items[0].title, "改 A")

  store.sync({ issues: { [KEY]: { title: "改 A", state: "pr-open" } }, prSeen: {} })
  h = store.history({ days: 0 })
  assert.equal(h.total, 2)
  const st = h.groups[0].items.find((i) => i.kind === "task_state")
  assert.equal(st.from, "working")
  assert.equal(st.to, "pr-open")
  assert.equal(st.number, 250)
  store.close()
})

test("同一状态反复同步不重复记事件", () => {
  const store = tmpStore()
  const book = { issues: { [KEY]: { title: "改 A", state: "working" } }, prSeen: {} }
  store.sync(book)
  store.sync(book)
  store.sync(book)
  const h = store.history({ days: 0 })
  assert.equal(h.total, 1, "状态没变就不该再记")
  assert.equal(h.groups[0].items[0].kind, "task_new")
  store.close()
})

test("attempts 增长记 task_attempt", () => {
  const store = tmpStore()
  store.sync({ issues: { [KEY]: { title: "改 A", state: "working", attempts: 1 } }, prSeen: {} })
  store.sync({ issues: { [KEY]: { title: "改 A", state: "working", attempts: 2 } }, prSeen: {} })
  const items = store.history({ days: 0 }).groups[0].items
  const retry = items.find((i) => i.kind === "task_attempt")
  assert.ok(retry, "第 2 次尝试要留一条")
  assert.equal(retry.detail, "第 2 次尝试")
  store.close()
})

test("PR：首次记 pr_new，通知后记 pr_state 并带目标", () => {
  const store = tmpStore()
  const prKey = "yyzl/win-ai-harness#260"

  store.sync({ issues: {}, prSeen: { [prKey]: { repo: "yyzl/win-ai-harness", number: 260, title: "PR B", skipped: "self" } } })
  let h = store.history({ days: 0 })
  assert.equal(h.groups[0].items[0].kind, "pr_new")
  assert.equal(h.groups[0].items[0].to, "skipped")

  store.sync({ issues: {}, prSeen: { [prKey]: { repo: "yyzl/win-ai-harness", number: 260, title: "PR B", notifiedTo: "cli" } } })
  h = store.history({ days: 0 })
  const ch = h.groups[0].items.find((i) => i.kind === "pr_state")
  assert.equal(ch.from, "skipped")
  assert.equal(ch.to, "notified")
  assert.match(ch.detail, /已通知 cli/)
  store.close()
})

test("history：按天分组、repo/key 过滤、days=0 全部", () => {
  const store = tmpStore()
  const now = new Date()
  const old = new Date(now.getTime() - 40 * 86400000)
  const other = "yyzl/other-repo#7"

  store.event({ at: old.toISOString(), kind: "task_state", key: KEY, repo: "yyzl/win-ai-harness", number: 250, from: "working", to: "done" })
  store.event({ kind: "pr_open", key: "yyzl/win-ai-harness#260", repo: "yyzl/win-ai-harness", number: 260, to: "open" })
  store.event({ kind: "issue_close", key: other, repo: "yyzl/other-repo", number: 7, to: "done" })

  const all = store.history({ days: 0 })
  assert.equal(all.total, 3)
  assert.equal(all.groups.length, 2, "旧事件要单独占一天")

  const recent = store.history({ days: 7 })
  assert.equal(recent.total, 2, "40 天前那条不算近 7 天")
  assert.ok(!recent.groups.some((g) => g.items.some((i) => i.at === old.toISOString())))

  const byRepo = store.history({ days: 0, repo: "yyzl/other-repo" })
  assert.equal(byRepo.total, 1)
  assert.equal(byRepo.groups[0].items[0].key, other)

  const byKey = store.history({ days: 0, key: KEY })
  assert.equal(byKey.total, 1)
  assert.equal(byKey.groups[0].items[0].kind, "task_state")
  assert.equal(byKey.groups[0].items[0].from, "working")
  store.close()
})

test("history：按单日查（day=YYYY-MM-DD）与 availableDays 日期清单", () => {
  const store = tmpStore()
  const now = new Date()
  const day = (offset) => {
    const d = new Date(now.getTime() - offset * 86400000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }
  const d0 = day(0)
  const d3 = day(3)

  store.event({ at: new Date(now.getTime() - 3 * 86400000).toISOString(), kind: "task_state", key: KEY, repo: "yyzl/win-ai-harness", number: 250, from: "working", to: "done" })
  store.event({ kind: "pr_open", key: "yyzl/win-ai-harness#260", repo: "yyzl/win-ai-harness", number: 260, to: "open" })
  store.event({ kind: "pr_open", key: "yyzl/win-ai-harness#261", repo: "yyzl/win-ai-harness", number: 261, to: "open" })

  const onlyToday = store.history({ day: d0 })
  assert.equal(onlyToday.total, 2, "只返回这一天的事件")
  assert.ok(onlyToday.groups.every((g) => g.day === d0))
  assert.equal(onlyToday.day, d0)

  const oldDay = store.history({ day: d3 })
  assert.equal(oldDay.total, 1)
  assert.equal(oldDay.groups[0].items[0].kind, "task_state")

  const bad = store.history({ day: "not-a-date" })
  assert.equal(bad.total, 3, "非法日期忽略，退回默认窗口")

  const days = store.history({ days: 0 }).availableDays
  assert.deepEqual(days.map((x) => x.day).sort(), [d0, d3].sort())
  assert.equal(days.find((x) => x.day === d0).count, 2)
  store.close()
})

test("显式事件（建 PR / 合并 / 评论 / 关单）进历史，标题从当前行反查", () => {
  const store = tmpStore()
  store.sync({ issues: { [KEY]: { title: "改 A", state: "pr-open" } }, prSeen: {} })

  store.event({ kind: "pr_open", key: "yyzl/win-ai-harness#260", repo: "yyzl/win-ai-harness", number: 260, to: "open", detail: "sit-20261126 ← fix/issue-250 · 工单 #250" })
  store.event({ kind: "pr_merge", key: "yyzl/win-ai-harness#260", repo: "yyzl/win-ai-harness", number: 260, to: "merged", detail: "merge · 关单 #250" })
  store.event({ kind: "issue_comment", key: KEY, repo: "yyzl/win-ai-harness", number: 250, detail: "在改" })
  store.event({ kind: "issue_close", key: KEY, repo: "yyzl/win-ai-harness", number: 250, to: "done" })

  const h = store.history({ days: 0 })
  const kinds = h.groups[0].items.map((i) => i.kind)
  for (const k of ["pr_open", "pr_merge", "issue_comment", "issue_close"]) {
    assert.ok(kinds.includes(k), `${k} 要进历史`)
  }
  const merge = h.groups[0].items.find((i) => i.kind === "pr_merge")
  assert.match(merge.detail, /关单 #250/)
  const comment = h.groups[0].items.find((i) => i.kind === "issue_comment")
  assert.equal(comment.title, "改 A", "标题按 key 从当前行反查")
  store.close()
})

test("snapshot 支持按天回看：状态回放到当天，只列那天有变化的单/PR", () => {
  const store = tmpStore()
  store.sync({ issues: { [KEY]: { title: "改 A", state: "done" } }, prSeen: {} })

  const now = new Date()
  const at = (n) => new Date(now.getTime() - n * 86400000).toISOString()
  const day = (n) => {
    const d = new Date(now.getTime() - n * 86400000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  store.event({ at: at(2), kind: "task_new", key: KEY, repo: "yyzl/win-ai-harness", number: 250, to: "planned" })
  store.event({
    at: at(1),
    kind: "task_state",
    key: KEY,
    repo: "yyzl/win-ai-harness",
    number: 250,
    from: "planned",
    to: "working",
  })

  const mid = store.snapshot({ day: day(1) })
  assert.equal(mid.isToday, false)
  assert.equal(mid.day, day(1))
  assert.equal(mid.tasks.length, 1, "那天有状态变化的单要出现在列表里")
  assert.equal(mid.tasks[0].state, "working", "状态回放到那天，不是今天的 done")
  assert.equal(mid.stats.tasks, 1)
  assert.equal(mid.stats.historyTasks, 1, "累计口径只算到那天为止出现过的")
  assert.match(mid.tasks[0].url, /\/yyzl\/win-ai-harness\/issues\/250$/, "库里没有 url 时按仓库拼出工单页")

  const before = store.snapshot({ day: day(5) })
  assert.equal(before.tasks.length, 0, "事件之前的日子是空的")
  assert.equal(before.stats.historyTasks, 0)

  const today = store.snapshot({})
  assert.equal(today.isToday, true)
  assert.equal(today.tasks[0].state, "done", "不传 day 仍是今天的实时状态")
  store.close()
})
