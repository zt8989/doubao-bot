import test from "node:test"
import assert from "node:assert/strict"
import { eligible, sortIssues, CLOSED_STATES } from "../src/orchestrator.mjs"

const repoCfg = { name: "win-ai-harness", repo: "yyzl/win-ai-harness", dir: "/tmp/x", base: "dev" }

function cfg(over = {}) {
  return {
    maxAttempts: 3,
    pickup: {
      labelIds: [],
      labels: [],
      excludeLabels: ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"],
      onlyUnassigned: true,
      order: "oldest",
      ...over.pickup,
    },
  }
}

function book(issues = {}) {
  return { issue: (k) => issues[k] ?? null }
}

const issue = (n, extra = {}) => ({
  number: n,
  title: `#${n}`,
  labels: [],
  assignees: [],
  createdAt: "2026-11-01T00:00:00Z",
  ...extra,
})

test("labelIds 走服务端过滤后，不再拿 labels 名字做二次过滤", () => {
  // opencli 列表接口不回 labels；配了 labelIds 时若仍按名字筛，会一条都捞不到。
  const c = cfg({ pickup: { labelIds: [5], labels: ["ready-for-agent"] } })
  const list = [issue(255), issue(256)]
  assert.equal(eligible(list, repoCfg, c, book()).length, 2)
})

test("没配 labelIds 时才按 labels 名字 AND 过滤", () => {
  const c = cfg({ pickup: { labels: ["ready-for-agent"] } })
  assert.equal(eligible([issue(1, { labels: ["ready-for-agent"] })], repoCfg, c, book()).length, 1)
  assert.equal(eligible([issue(2, { labels: [] })], repoCfg, c, book()).length, 0)
})

test("excludeLabels 命中即跳过，大小写不敏感", () => {
  const c = cfg()
  const out = eligible([issue(1, { labels: ["Needs-Human"] })], repoCfg, c, book())
  assert.equal(out.length, 0)
})

test("onlyUnassigned 时已指派的单跳过", () => {
  const c = cfg()
  assert.equal(eligible([issue(1, { assignees: ["teng"] })], repoCfg, c, book()).length, 0)
  const off = cfg({ pickup: { onlyUnassigned: false } })
  assert.equal(eligible([issue(1, { assignees: ["teng"] })], repoCfg, off, book()).length, 1)
})

test("已处理过（CLOSED_STATES）的单不再捞", () => {
  const c = cfg()
  const b = book({ "yyzl/win-ai-harness#1": { state: "pr-open" } })
  assert.equal(eligible([issue(1)], repoCfg, c, b).length, 0)
  for (const s of CLOSED_STATES) {
    const bb = book({ "yyzl/win-ai-harness#2": { state: s } })
    assert.equal(eligible([issue(2)], repoCfg, c, bb).length, 0, `${s} 不该再被捞`)
  }
})

test("working 且 attempts 到上限的跳过，没到上限的还能接", () => {
  const c = cfg()
  const b = book({ "yyzl/win-ai-harness#1": { state: "working", attempts: 3 } })
  assert.equal(eligible([issue(1)], repoCfg, c, b).length, 0)
  const b2 = book({ "yyzl/win-ai-harness#1": { state: "working", attempts: 1 } })
  assert.equal(eligible([issue(1)], repoCfg, c, b2).length, 1)
})

test("排序：默认最老先接，newest 反过来", () => {
  const a = issue(1, { createdAt: "2026-11-01T00:00:00Z" })
  const b = issue(2, { createdAt: "2026-11-05T00:00:00Z" })
  assert.deepEqual(sortIssues([b, a], "oldest").map((x) => x.number), [1, 2])
  assert.deepEqual(sortIssues([a, b], "newest").map((x) => x.number), [2, 1])
})

test("三档优先级：我的（作者是 233151）→ 无人认领 → 他人，同档按最老先接", () => {
  const me = "233151"
  const mine = issue(10, { author: "233151", createdAt: "2026-11-09T00:00:00Z" })
  const free = issue(20, { author: "zhangsan", createdAt: "2026-11-01T00:00:00Z" })
  const other = issue(30, { author: "lisi", assignees: ["wangwu"], createdAt: "2026-10-01T00:00:00Z" })
  const out = sortIssues([other, free, mine], "oldest", { me, priority: ["mine", "unassigned", "others"] })
  assert.deepEqual(out.map((x) => x.number), [10, 20, 30])

  // 换成无人认领优先，顺序跟着变；同类内仍是最老先接
  const freeOld = issue(21, { author: "zhangsan", createdAt: "2026-10-20T00:00:00Z" })
  const out2 = sortIssues([mine, free, freeOld], "oldest", { me, priority: ["unassigned", "mine", "others"] })
  assert.deepEqual(out2.map((x) => x.number), [21, 20, 10])
})

test("onlyUnassigned: false 时，别人的单也进候选（排最后一档）", () => {
  const c = cfg({ pickup: { onlyUnassigned: false, me: "233151", priority: ["mine", "unassigned", "others"] } })
  const pool = sortIssues(eligible([
    issue(1, { author: "233151" }),
    issue(2, { author: "zhangsan" }),
    issue(3, { author: "lisi", assignees: ["wangwu"] }),
  ], repoCfg, c, book()), c.pickup.order, { me: c.pickup.me, priority: c.pickup.priority })
  assert.deepEqual(pool.map((x) => x.number), [1, 2, 3])
})
