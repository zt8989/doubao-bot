// 存量接口变更巡检：扫描/粗筛/去重/判官投递。不出网，gitea 用假适配器。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { apiWatchOnce, judgePrompt, judgeSessionName, deliverApiBreakCandidates, touchesInterface, diffFiles } from "../src/apiwatch.mjs"
import { Book } from "../src/book.mjs"

const CONTROLLER_DIFF = [
  "diff --git a/src/FooController.java b/src/FooController.java",
  "--- a/src/FooController.java",
  "+++ b/src/FooController.java",
  "@@ -10,7 +10,7 @@",
  "-  public Resp get(String a) {",
  "+  public Resp get(String a, String b) {",
].join("\n")

const FRONTEND_DIFF = [
  "diff --git a/web/src/pages/Home.vue b/web/src/pages/Home.vue",
  "--- a/web/src/pages/Home.vue",
  "+++ b/web/src/pages/Home.vue",
  "+<p>hello</p>",
].join("\n")

const pr = (over = {}) => ({
  number: 1,
  title: "改接口",
  url: "http://gitea.test/o/r/pulls/1",
  author: "alice",
  merged: true,
  mergedAt: "2026-11-27T01:00:00Z",
  ...over,
})

function fixture({ pulls = {}, section = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-apiwatch-"))
  const calls = []
  const gitea = {
    listPulls: async (repo, { page }) => {
      calls.push({ fn: "listPulls", repo, page })
      return pulls[repo]?.[page - 1] ?? []
    },
    pullPrDiff: async (repo, number) => {
      calls.push({ fn: "pullPrDiff", repo, number })
      return pulls.diffs?.[`${repo}#${number}`] ?? CONTROLLER_DIFF
    },
  }
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    repos: [{ repo: "o/r" }, { repo: "o/r2" }],
    apiWatch: {
      enabled: true,
      chatIds: ["oc_group1"],
      ...section,
    },
  }
  const ctx = { state: {}, cfg, gitea, log: () => {} }
  return { ctx, cfg, calls }
}

test("apiWatchOnce 首轮：接口文件候选入箱，纯前端 diff 不入", async () => {
  const { ctx } = fixture({
    pulls: {
      "o/r": [[pr({ number: 1 }), pr({ number: 2, title: "改前端" })]],
      diffs: { "o/r#1": CONTROLLER_DIFF, "o/r#2": FRONTEND_DIFF },
    },
  })
  const r = await apiWatchOnce(ctx)
  assert.equal(r.ok, true)
  assert.equal(r.scanned, 2)
  assert.equal(r.candidates, 1)
  assert.equal(r.inbox.type, "apibreak.candidates")
  assert.match(r.inbox.text, /o\/r#1/)
  assert.doesNotMatch(r.inbox.text, /改前端/)
  assert.deepEqual(r.inbox.json.chatIds, ["oc_group1"])
  assert.equal(r.inbox.json.prs[0].repo, "o/r")
  assert.match(r.inbox.json.prs[0].diff, /\+  public Resp get\(String a, String b\)/)
  // 处理过的都打 apiCheckedAt（含粗筛未命中的），下轮不再扫
  const book = new Book(ctx.cfg.stateFile)
  assert.ok(book.prSeen["o/r#1"].apiCheckedAt)
  assert.equal(book.prSeen["o/r#2"].via, "apiwatch")
  assert.ok(book.prSeen["o/r#2"].apiCheckedAt)
})

test("apiWatchOnce 次轮：同一批 PR 静默（增量去重）", async () => {
  const { ctx } = fixture({
    pulls: { "o/r": [[pr({ number: 1 })]], diffs: { "o/r#1": CONTROLLER_DIFF } },
  })
  const first = await apiWatchOnce(ctx)
  assert.equal(first.candidates, 1)
  const second = await apiWatchOnce(ctx)
  assert.equal(second.ok, true)
  assert.equal(second.scanned, 0)
  assert.equal(second.candidates, 0)
  assert.equal(second.inbox, false)
})

test("apiWatchOnce：enabled=false 跳过，force 照跑；chatIds 空 skip", async () => {
  const { ctx, cfg } = fixture({ pulls: { "o/r": [[pr()]] } })
  cfg.apiWatch.enabled = false
  const skipped = await apiWatchOnce(ctx)
  assert.equal(skipped.skipped, "disabled")
  const forced = await apiWatchOnce(ctx, { force: true })
  assert.equal(forced.ok, true)
  cfg.apiWatch.enabled = true
  cfg.apiWatch.chatIds = []
  const noIds = await apiWatchOnce(ctx)
  assert.equal(noIds.skipped, "no-chat-ids")
})

test("apiWatchOnce：候选封顶，超出的留到下一轮", async () => {
  const { ctx } = fixture({
    pulls: { "o/r": [[pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })]] },
    section: { maxPrsPerRound: 2 },
  })
  const r = await apiWatchOnce(ctx)
  assert.equal(r.candidates, 2)
  const book = new Book(ctx.cfg.stateFile)
  assert.ok(book.prSeen["o/r#1"].apiCheckedAt)
  assert.ok(book.prSeen["o/r#2"].apiCheckedAt)
  assert.ok(!book.prSeen["o/r#3"]?.apiCheckedAt, "没轮到的不能打标")
  const next = await apiWatchOnce(ctx)
  assert.equal(next.candidates, 1)
})

test("apiWatchOnce：repos 过滤，只扫配了的仓", async () => {
  const { ctx } = fixture({
    pulls: { "o/r": [[pr()]], "o/r2": [[pr({ number: 9 })]] },
    section: { repos: ["o/r2"] },
  })
  const r = await apiWatchOnce(ctx)
  assert.equal(r.scanned, 1)
  assert.equal(r.inbox.json.prs[0].repo, "o/r2")
})

test("apiWatchOnce：diff 超长截断，不吞掉候选资格", async () => {
  const { ctx } = fixture({
    pulls: { "o/r": [[pr({ number: 1 })]] },
    section: { maxDiffChars: 500 },
  })
  ctx.gitea.pullPrDiff = async () => CONTROLLER_DIFF + "\n+".padEnd(12000, "x")
  const r = await apiWatchOnce(ctx)
  assert.equal(r.candidates, 1)
  assert.ok(r.inbox.json.prs[0].diff.length <= 560)
  assert.match(r.inbox.json.prs[0].diff, /diff 已截断/)
})

test("apiWatchOnce：拉 diff 失败不打标，下轮重试", async () => {
  const { ctx } = fixture({
    pulls: { "o/r": [[pr({ number: 1 })]], diffs: { "o/r#1": CONTROLLER_DIFF } },
  })
  ctx.gitea.pullPrDiff = async () => { throw new Error("网络抖了") }
  const r = await apiWatchOnce(ctx)
  assert.equal(r.candidates, 0)
  const book = new Book(ctx.cfg.stateFile)
  assert.ok(!book.prSeen["o/r#1"]?.apiCheckedAt, "失败的不打已检标")
  // 下一轮恢复后照常处理同一条
  ctx.gitea.pullPrDiff = async () => CONTROLLER_DIFF
  const next = await apiWatchOnce(ctx)
  assert.equal(next.candidates, 1)
})

test("diffFiles/touchesInterface：+++, b/ 路径抽取与模式命中", () => {
  const files = diffFiles(CONTROLLER_DIFF)
  assert.deepEqual(files, ["src/FooController.java"])
  assert.equal(touchesInterface(CONTROLLER_DIFF, ["controller"]), true)
  assert.equal(touchesInterface(FRONTEND_DIFF, ["controller"]), false)
  assert.equal(touchesInterface(FRONTEND_DIFF, []), false, "空模式回落代码默认，Home.vue 不命中")
})

test("judgePrompt：含判断标准、发群指令、chatId 与 diff", () => {
  const p = judgePrompt({
    prs: [{ repo: "o/r", number: 1, title: "改接口", url: "http://x/1", author: "a", mergedAt: "t", diff: CONTROLLER_DIFF }],
    chatIds: ["oc_group1"],
  })
  assert.match(p, /对外接口变更判官/)
  assert.match(p, /JWT/, "受众=JWT 鉴权的外部联调接口")
  assert.match(p, /内部逻辑变更，一律不通知/, "内部逻辑明确排除")
  assert.match(p, /foreman send --type feishu --chat-id <chatId>/)
  assert.match(p, /--dedupe-key apiwatch:<repo>#<序号>/)
  assert.match(p, /- oc_group1/, "目标群 chatId 列表逐字给出")
  assert.match(p, /\+  public Resp get\(String a, String b\)/)
})

test("deliverApiBreakCandidates：开一次性判官会话，空 payload 跳过", async () => {
  const opened = []
  const ctx = { session: { openNew: async (args) => { opened.push(args); return { ok: true, convId: "conv-1" } } }, log: () => {} }
  const skipped = await deliverApiBreakCandidates(ctx, { payload: { prs: [], chatIds: ["oc_1"] } })
  assert.equal(skipped.skipped, "empty")
  const r = await deliverApiBreakCandidates(ctx, {
    payload: { chatIds: ["oc_group1"], prs: [{ repo: "o/r", number: 1, title: "T", diff: CONTROLLER_DIFF }] },
  })
  assert.equal(r.ok, true)
  assert.equal(r.convId, "conv-1")
  assert.match(opened[0].name, /^foreman-接口巡检-\d{8}-\d{4}$/)
  assert.equal(opened[0].noWait, true)
  assert.match(opened[0].prompt, /oc_group1/)
})

test("deliverApiBreakCandidates：投递报错时 throw（Inbox 走重试）", async () => {
  const ctx = { session: { openNew: async () => ({ ok: false, error: "载体不可用" }) }, log: () => {} }
  await assert.rejects(
    () => deliverApiBreakCandidates(ctx, { payload: { chatIds: ["oc_1"], prs: [{ repo: "o/r", number: 1 }] } }),
    /载体不可用/
  )
})

test("judgeSessionName：时间戳命名", () => {
  // 本地时区的 2026-11-27 10:30 → 20261127-1030（用带时区偏移的本地时间构造）
  const at = new Date(2026, 10, 27, 10, 30)
  assert.equal(judgeSessionName(at), "foreman-接口巡检-20261127-1030")
})
