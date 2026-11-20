import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pickupWatchOnce, assignedToMe, hasReadyLabel } from "../src/pickupwatch.mjs"
import { pickupPollOnce } from "../src/service.mjs"

const repoCfg = {
  name: "win-ai-harness",
  repo: "yyzl/win-ai-harness",
  dir: "/tmp/x",
  base: "sit-20261126",
  labelIds: [5],
}

function config({ me = "233151", issues = {}, auto = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-pickup-watch-"))
  const stateFile = path.join(dir, "state.json")
  fs.writeFileSync(stateFile, JSON.stringify({ issues }))
  return {
    stateFile,
    repos: [repoCfg],
    maxAttempts: 3,
    pickup: {
      auto,
      me,
      labelIds: [5],
      excludeLabels: ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"],
      onlyUnassigned: false,
      order: "oldest",
    },
  }
}

const issue = (number, extra = {}) => ({
  number,
  title: `工单 ${number}`,
  labels: ["ready-for-agent"],
  assignees: ["233151"],
  author: "someone-else",
  state: "open",
  url: `http://106.54.199.229:3000/yyzl/win-ai-harness/issues/${number}`,
  createdAt: `2026-11-${String(number).padStart(2, "0")}T00:00:00Z`,
  ...extra,
})

test("只把指派给 pickup.me 且带 ready-for-agent 的 open 候选写入 router Inbox", async () => {
  const cfg = config({
    issues: {
      "yyzl/win-ai-harness#4": { state: "handed" },
      "yyzl/win-ai-harness#5": { state: "planned" },
      "yyzl/win-ai-harness#6": { state: "working", attempts: 1, lastFailure: "" },
      "yyzl/win-ai-harness#9": { state: "working", attempts: 1, lastFailure: "上次投递失败" },
    },
  })
  const list = [
    issue(8),
    issue(1),
    issue(2, { assignees: ["other"] }),
    issue(3, { assignees: [] }),
    issue(4),
    issue(5),
    issue(6),
    issue(7, { labels: ["ready-for-agent", "needs-human"] }),
    issue(9),
    issue(10, { state: "closed" }),
    issue(11, { author: "233151", assignees: ["other"] }),
    issue(12, { labels: ["needs-triage"] }),
  ]
  const calls = []
  const notices = []
  const out = await pickupWatchOnce({
    cfg,
    gitea: { listIssues: async (repo, opts) => { calls.push({ repo, opts }); return list } },
    inspect: async (event) => { notices.push(event); return { ok: true, convId: "router-1" } },
  })

  assert.deepEqual(calls, [{ repo: repoCfg.repo, opts: { label: "5" } }])
  assert.deepEqual(out.issues, ["yyzl/win-ai-harness#1", "yyzl/win-ai-harness#8", "yyzl/win-ai-harness#9"])
  assert.equal(out.notified, 3)
  assert.equal(out.pending, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].type, "issue.candidates")
  assert.deepEqual(notices[0].json.issues.map((x) => x.number), [1, 8, 9])
  assert.match(notices[0].text, /foreman hand yyzl\/win-ai-harness#1/)
  assert.match(notices[0].text, /foreman tasks --json/)
  assert.match(notices[0].text, /内部编码 sub agent/)
  assert.doesNotMatch(notices[0].text, /dispatch 编码智能体/)
  assert.doesNotMatch(notices[0].text, /foreman run --once/)
})

test("候选为空时不调用 router；指派人与标签判断严格区分作者", async () => {
  let notified = 0
  const cfg = config()
  const out = await pickupWatchOnce({
    cfg,
    gitea: { listIssues: async () => [issue(1, { assignees: ["other"], author: "233151" }), issue(2, { labels: [] })] },
    inspect: async () => { notified++ },
  })
  assert.equal(out.notified, 0)
  assert.equal(out.pending, 0)
  assert.equal(notified, 0)
  assert.equal(assignedToMe(issue(1), "233151"), true)
  assert.equal(assignedToMe(issue(1, { author: "233151", assignees: ["other"] }), "233151"), false)
  assert.equal(hasReadyLabel(issue(1, { labels: ["Ready-For-Agent"] })), true)
})

test("Inbox 写入失败时保留下轮重试，不伪报已通知", async () => {
  const out = await pickupWatchOnce({
    cfg: config(),
    gitea: { listIssues: async () => [issue(1)] },
    inspect: async () => ({ ok: false, error: "inbox unavailable" }),
  })
  assert.equal(out.notified, 0)
  assert.equal(out.pending, 1)
  assert.equal(out.failedNotify, true)
})

test("pickup.me 缺失时明确报错，不退化成接无人认领或他人工单", async () => {
  const out = await pickupWatchOnce({ cfg: config({ me: "" }), gitea: { listIssues: async () => [issue(1)] } })
  assert.equal(out.ok, false)
  assert.match(out.error, /pickup.me/)
})

test("服务手动扫描用 force 绕过 auto 开关，但仍只入箱", async () => {
  const cfg = config({ auto: false })
  let listed = 0
  let notified = 0
  const ctx = {
    cfg,
    state: { pickup: {} },
    log: () => {},
    gitea: { listIssues: async () => { listed++; return [issue(1)] } },
    notifyRouter: async () => { notified++; return { ok: true } },
  }
  const disabled = await pickupPollOnce(ctx)
  assert.equal(disabled.skipped, "disabled")
  assert.equal(listed, 0)

  const out = await pickupPollOnce(ctx, { force: true })
  assert.equal(out.notified, 1)
  assert.equal(listed, 1)
  assert.equal(notified, 1)
  assert.equal(ctx.state.pickup.pollCount, 1)
})
