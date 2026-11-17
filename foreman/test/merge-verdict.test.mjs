// 合并助手交 RESULT → workflow 合并：judge 纯函数 + 一轮消费（mergeVerdictOnce）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { judgeMergeVerdict, mergeVerdictOnce, verdictSessions, mergeJudgeStat, deliverNewSession } from "../src/service.mjs"
import { parseResult } from "../src/prompts.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-verdict-"))
}

function mkCfg(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    pollSeconds: 20,
    // existing 模式：合并回执走 dws.notify，测试里直接收进 sends
    deliver: { mode: "existing" },
    notify: { enabled: true, session: "boss", events: ["done"] },
    merge: { enabled: true, style: "merge", deleteBranch: true, by: "foreman", verdictAutoMerge: true },
    ...over,
  }
}

// 一条「PR待合并」合并会话记录（过了 60s 宽限期，可以读结论）
function seedSession(cfg, { name = "foreman-合并-20261112-1600", convId = "conv-m1", notice = "PR待合并", repo = "demo/demo" } = {}) {
  const b = new Book(cfg.stateFile)
  b.record(name, {
    convId,
    kind: "deliver:merge",
    notify: false,
    notice,
    repo,
    createdAt: new Date(Date.now() - 120000).toISOString(),
  })
  return name
}

const verdict = {
  status: "done",
  repo: "demo/demo",
  pr: 268,
  prUrl: "http://gitea/demo/demo/pulls/268",
  branch: "fix/issue-260",
  base: "sit-20261126",
  mergeable: true,
  conflict: "resolved",
  tests: "mvn -q -DskipTests compile 通过",
  summary: "冲突已解，可合",
}

test("parseResult 把合并结论字段带出来（mergeable / conflict / items）", () => {
  const r = parseResult(`<RESULT>${JSON.stringify(verdict)}</RESULT>`)
  assert.equal(r.status, "done")
  assert.equal(r.mergeable, true)
  assert.equal(r.conflict, "resolved")
  assert.equal(r.repo, "demo/demo")
  assert.equal(r.pr, 268)
  assert.equal(r.base, "sit-20261126")

  const r2 = parseResult('<RESULT>{"status":"done","pr":12}</RESULT>')
  assert.equal(r2.mergeable, null, "没表态不等于可合")

  const r3 = parseResult(`<RESULT>${JSON.stringify({
    status: "done", pr: 12, mergeable: "true",
    items: [{ repo: "demo/a", pr: 12, mergeable: true }, { repo: "demo/b", pr: 13, mergeable: false }],
  })}</RESULT>`)
  assert.equal(r3.items.length, 2)
  assert.equal(r3.items[1].mergeable, false)
})

test("parseResult 兼容旧合并会话的顶层数组，并生成多条自动合并任务", () => {
  const rows = [
    { ...verdict, pr: 318, prUrl: "http://gitea/demo/demo/pulls/318", summary: "#318 可合" },
    { ...verdict, pr: 319, prUrl: "http://gitea/demo/demo/pulls/319", summary: "#319 可合" },
  ]
  const result = parseResult(`<RESULT>${JSON.stringify(rows)}</RESULT>`)
  assert.equal(result.status, "done")
  assert.equal(result.mergeable, true)
  assert.equal(result.items.length, 2)

  const dir = tmpDir()
  try {
    const d = judgeMergeVerdict({
      cfg: mkCfg(dir),
      record: { repo: "demo/demo" },
      result,
      book: new Book(path.join(dir, "state.json")),
    })
    assert.equal(d.action, "merge")
    assert.deepEqual(d.tasks.map((t) => t.key), ["demo/demo#318", "demo/demo#319"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("verdictSessions：只认「PR待合并」的合并会话，回执会话不算", () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    seedSession(cfg, { name: "s-1", convId: "conv-1" })
    seedSession(cfg, { name: "s-2", convId: "conv-2", notice: "合并完成" })
    const list = verdictSessions(new Book(cfg.stateFile))
    assert.deepEqual(list.map((c) => c.name), ["s-1"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("judgeMergeVerdict：开关、没结论、不可合、可合、账本已合", () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    const record = { name: "s-1", repo: "demo/demo" }

    assert.equal(judgeMergeVerdict({ cfg: mkCfg(dir, { merge: { enabled: false } }), record, result: verdict, book }).reason, "disabled")
    assert.equal(
      judgeMergeVerdict({ cfg: mkCfg(dir, { merge: { enabled: true, verdictAutoMerge: false } }), record, result: verdict, book }).reason,
      "verdict-auto-off",
    )
    assert.equal(judgeMergeVerdict({ cfg, record, result: null, book }).action, "wait")
    assert.equal(judgeMergeVerdict({ cfg, record, result: parseResult("还在看"), book }).action, "wait")

    const held = judgeMergeVerdict({ cfg, record, result: { ...parseResult(`<RESULT>${JSON.stringify({ ...verdict, status: "blocked", mergeable: false })}</RESULT>`) }, book })
    assert.equal(held.action, "hold")
    assert.equal(held.reason, "blocked")

    const notMergeable = judgeMergeVerdict({ cfg, record, result: { ...parseResult(`<RESULT>${JSON.stringify({ ...verdict, mergeable: false })}</RESULT>`) }, book })
    assert.equal(notMergeable.action, "hold")
    assert.equal(notMergeable.reason, "not-mergeable")

    const noPr = judgeMergeVerdict({ cfg, record, result: { ...parseResult(`<RESULT>${JSON.stringify({ ...verdict, pr: null })}</RESULT>`) }, book })
    assert.equal(noPr.action, "hold")
    assert.equal(noPr.reason, "no-pr")

    // 没写 mergeable 不能当「可以合」
    const noVerdict = judgeMergeVerdict({ cfg, record, result: parseResult(`<RESULT>${JSON.stringify({ status: "done", pr: 268 })}</RESULT>`), book })
    assert.equal(noVerdict.action, "hold")
    assert.equal(noVerdict.reason, "no-mergeable-verdict")

    const d = judgeMergeVerdict({ cfg, record, result: parseResult(`<RESULT>${JSON.stringify(verdict)}</RESULT>`), book })
    assert.equal(d.action, "merge")
    assert.deepEqual(d.tasks, [{ key: "demo/demo#268", repo: "demo/demo", pr: 268, url: "http://gitea/demo/demo/pulls/268" }])

    book.markMergeAsked("demo/demo#268", { pr: 268, status: "merged" })
    assert.equal(judgeMergeVerdict({ cfg, record, result: parseResult(`<RESULT>${JSON.stringify(verdict)}</RESULT>`), book }).action, "done")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("mergeVerdictOnce：读结论 → 走 workflow 合并 → 判断账收口", async () => {
  const dir = tmpDir()
  try {
    // deliver.mode: new 时最容易出新会话：这里盯死「合并由代码落地，不再回一条合并完成」。
    const cfg = mkCfg(dir, { deliver: { mode: "new" } })
    const name = seedSession(cfg)
    const merged = []
    const closed = []
    const sends = []
    const delivered = []
    let infoCalls = 0
    const gitea = {
      listPulls: async () => [],
      mergePr: async (repo, pr, opts) => { merged.push({ repo, pr, opts }) },
      closeIssue: async (repo, n) => { closed.push({ repo, n }) },
      viewPr: async () => null,
    }
    const ctx = {
      cfg,
      log: () => {},
      gitea,
      deliver: async (arg) => { delivered.push(arg) },
      dws: {
        info: async () => { infoCalls++; return { lastReply: `<RESULT>${JSON.stringify(verdict)}</RESULT>` } },
        notify: async (target, text) => sends.push({ target, text }),
      },
      consoleStore: { event: () => {} },
    }
    const out = await mergeVerdictOnce(ctx, { sidebar: { "conv-m1": { running: false } } })
    assert.equal(out.merged, 1)
    assert.deepEqual(merged, [{ repo: "demo/demo", pr: 268, opts: { style: "merge", deleteBranch: true } }])
    assert.equal(delivered.length, 0, "合并由代码落地，不再新开一条回执会话")
    assert.equal(sends.length, 0, "也不给已有会话发合并回执")
    assert.equal(infoCalls, 1, "判过一次就不再读会话")
    const led = new Book(cfg.stateFile).mergeJudge[name]
    assert.equal(led.status, "merged")

    // 再跑一轮：已收口，一个字节都不再读
    await mergeVerdictOnce(ctx, { sidebar: { "conv-m1": { running: false } } })
    assert.equal(infoCalls, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("mergeVerdictOnce：会话还在跑/刚投递不读；不可合只记账不合", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const name = seedSession(cfg)
    let infoCalls = 0
    let mergeCalls = 0
    const gitea = { listPulls: async () => [], mergePr: async () => { mergeCalls++ }, closeIssue: async () => {}, viewPr: async () => null }
    const ctx = {
      cfg, log: () => {}, gitea,
      dws: { info: async () => { infoCalls++; return { lastReply: `<RESULT>${JSON.stringify({ ...verdict, status: "need_decision", mergeable: false, question: "堆叠 PR，先合 #267？" })}</RESULT>` } } },
      consoleStore: { event: () => {} },
    }
    // 还在跑：不读
    await mergeVerdictOnce(ctx, { sidebar: { "conv-m1": { running: true } } })
    assert.equal(infoCalls, 0)

    // 刚投递（宽限期内）：不读
    new Book(cfg.stateFile).record(name, { createdAt: new Date().toISOString() })
    await mergeVerdictOnce(ctx, { sidebar: { "conv-m1": { running: false } } })
    assert.equal(infoCalls, 0)

    // 过了宽限期：读一次 → need_decision 挂起，不合并
    new Book(cfg.stateFile).record(name, { createdAt: new Date(Date.now() - 120000).toISOString() })
    const out = await mergeVerdictOnce(ctx, { sidebar: { "conv-m1": { running: false } } })
    assert.equal(infoCalls, 1)
    assert.equal(mergeCalls, 0)
    assert.equal(out.held, 1)
    const led = new Book(cfg.stateFile).mergeJudge[name]
    assert.equal(led.status, "held")
    assert.equal(led.reason, "need_decision")

    // 已挂起就不再读
    await mergeVerdictOnce(ctx, { sidebar: { "conv-m1": { running: false } } })
    assert.equal(infoCalls, 1)
    assert.equal(mergeJudgeStat(new Book(cfg.stateFile)).held, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("deliverNewSession：合并会话记下触发类型与仓库", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, {
      deliver: { mode: "new", promptFile: path.join(dir, "merge.md"), waitFirstReply: false },
    })
    fs.writeFileSync(path.join(dir, "merge.md"), "# 合并助手\n")
    const ctx = {
      cfg, log: () => {},
      dws: { openNew: async () => ({ convId: "conv-new" }) },
    }
    const out = await deliverNewSession(ctx, { text: "PR demo/demo#268 待合并", kind: "PR待合并", repo: "demo/demo", lane: "merge" })
    assert.equal(out.convId, "conv-new")
    const rec = new Book(cfg.stateFile).session(out.session)
    assert.equal(rec.notice, "PR待合并")
    assert.equal(rec.repo, "demo/demo")
    assert.equal(rec.kind, "deliver:merge")
    assert.equal(rec.notify, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
