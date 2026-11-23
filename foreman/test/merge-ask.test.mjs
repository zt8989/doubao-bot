// 自动合并：会话 done + 带 PR + 有自证 → 由编排（foreman）自己合并，不再让执行会话去合。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mergeDecision, startServer, runMergeTask, completeIssue } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-merge-"))
}

function mkCfg(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    pollSeconds: 20,
    notify: { enabled: true, session: "boss", events: ["done"] },
    merge: { enabled: true, style: "merge", deleteBranch: true, by: "foreman" },
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
    },
    ...over,
  }
}

const doneResult = {
  status: "done",
  branch: "fix/issue-9",
  pr: 12,
  prUrl: "http://gitea/demo/demo/pulls/12",
  tests: "node --test test/*.test.mjs 通过",
  summary: "改完了",
}

function mkDws(replies, sends) {
  let i = 0
  return {
    status: async () => ({ name: "conv-work", streaming: false, finished: true, chars: 200, head: "H", tail: "T", status: "ok" }),
    info: async () => ({ lastReply: `<RESULT>${replies[Math.min(i++, replies.length - 1)]}</RESULT>` }),
    notify: async (target, text) => { sends.push({ target, text }) },
  }
}

test("mergeDecision：开关、执行方、状态、PR、自证、去重", () => {
  const dir = tmpDir()
  try {
    const book = new Book(path.join(dir, "state.json"))
    const watcher = { target: "conv-1", repo: "demo/demo", number: 9, issueKey: "demo/demo#9" }
    const base = mkCfg(dir)

    assert.equal(mergeDecision({ cfg: { merge: { enabled: false } }, watcher, book, result: doneResult }).reason, "disabled")
    assert.equal(mergeDecision({ cfg: { merge: { enabled: true, by: "agent" } }, watcher, book, result: doneResult }).reason, "by-agent")
    assert.equal(mergeDecision({ cfg: base, watcher, book, result: { ...doneResult, status: "blocked" } }).reason, "not-done")
    assert.equal(mergeDecision({ cfg: base, watcher, book, result: { ...doneResult, pr: null } }).reason, "no-pr")
    assert.equal(mergeDecision({ cfg: base, watcher, book, result: { ...doneResult, tests: "" } }).reason, "no-self-test")

    const d = mergeDecision({ cfg: base, watcher, book, result: doneResult })
    assert.equal(d.send, true)
    assert.equal(d.key, "demo/demo#12")
    assert.equal(d.repo, "demo/demo")
    assert.equal(d.pr, 12)
    assert.equal(d.issueNumber, 9)

    book.markMergeAsked(d.key, { pr: 12, status: "merged" })
    assert.equal(mergeDecision({ cfg: base, watcher, book, result: doneResult }).reason, "already-asked")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("poll：不解析旧 RESULT 或自动记 PR；只有显式 runMergeTask 才合并", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-work", name: "foreman-demo-9", issueKey: "demo/demo#9", repo: "demo/demo", number: 9, notifyTo: "boss" })
    book.setIssue("demo/demo#9", { state: "working", title: "测试单" })

    const sends = []
    const merged = []
    const closed = []
    const gitea = {
      listPulls: async () => [],
      mergePr: async (repo, pr, opts) => { merged.push({ repo, pr, opts }) },
      closeIssue: async (repo, n) => { closed.push({ repo, n }) },
    }
    const dws = {
      runningMap: async () => ({ "conv-work": { running: false } }),
      status: async () => ({ name: "conv-work", streaming: false, finished: true, chars: 200, head: "H", tail: "T", status: "ok" }),
      info: async () => ({ lastReply: `<RESULT>${JSON.stringify(doneResult)}</RESULT>` }),
      queue: async (target, text) => { sends.push({ target, text }) },
    }
    server = await startServer({ cfg, book, dws, gitea, log: () => {} })

    // 即使旧会话仍返回 RESULT，poll 也只当普通文本入箱，不自动记 PR、不改状态。
    const r1 = await server.poll()
    assert.equal(r1.queued, undefined)
    await server.worker.idle()
    await server.worker.runOnce()
    assert.equal(sends.length, 1)
    assert.equal(merged.length, 0, "poll 不合并")
    const rec = new Book(cfg.stateFile).issue("demo/demo#9")
    assert.equal(rec.state, "working")
    assert.equal(rec.pr, undefined)
    // 账本里带着实现工作区：合并时要把「工程 + worktree」指出来。
    new Book(cfg.stateFile).setIssue("demo/demo#9", { worktree: "/w/demo/fix-issue-9", branch: "fix/issue-9" })

    // 编排核对后手动合：runMergeTask 直接执行，合完关单，不回执通知。
    const logs = []
    const out = await runMergeTask(
      { cfg, log: (s) => logs.push(String(s)), gitea, dws: mkDws([], sends) },
      { key: "demo/demo#12", repo: "demo/demo", pr: 12, issue: 9, notifyTo: "boss", workflow: "own", cleanup: true }
    )
    assert.equal(out.ok, true)
    assert.deepEqual(merged[0], { repo: "demo/demo", pr: 12, opts: { style: "merge", deleteBranch: true } })
    assert.deepEqual(closed, [{ repo: "demo/demo", n: 9 }], "cleanup:true 才走完整收尾（关单）")
    assert.equal(sends.length, 1, "合并不再额外回执；只保留此前的任务状态投递")
    // 合并结果要指明工程与 worktree（有的话）：回包与日志都带。
    assert.equal(out.repo, "demo/demo", "回包写明工程")
    assert.equal(out.worktree, "/w/demo/fix-issue-9", "回包写明 worktree")
    assert.ok(logs.some((s) => /工程 demo\/demo/.test(s) && s.includes("/w/demo/fix-issue-9")), "日志写明工程与 worktree")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runMergeTask 拆分：默认只合并——不动工作区、不关单，工单停 pr-open 等 clean", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("demo/demo#12", { state: "pr-open", pr: 12, branch: "fix/issue-12", worktree: "/w/demo/fix-issue-12" })
    const calls = { merge: 0, close: 0 }
    const gitea = {
      mergePr: async () => { calls.merge++ },
      closeIssue: async () => { calls.close++ },
      viewPr: async () => null,
    }
    const out = await runMergeTask({ cfg, log: () => {}, gitea, dws: {} }, { key: "demo/demo#12", repo: "demo/demo", pr: 12, issue: 12, notify: false })
    assert.equal(out.ok, true)
    assert.equal(calls.merge, 1)
    assert.equal(calls.close, 0, "合并-only 不关单")
    const rec = new Book(cfg.stateFile).issue("demo/demo#12")
    assert.equal(rec.state, "pr-open", "工单停在 pr-open 等 clean")
    const after = new Book(cfg.stateFile)
    assert.equal(after.mergeAsk["demo/demo#12"].status, "merged", "merge 节点盖 mergeAsk")
    assert.equal(after.prSeen["demo/demo#12"].merged, true, "pr-open 节点盖 prSeen.merged")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runMergeTask：冲突 → 不 force merge、只记失败，不回执通知", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const sends = []
    let attempts = 0
    const gitea = {
      listPulls: async () => [],
      mergePr: async () => { attempts++; throw new Error("此分支存在冲突，无法自动合并") },
      closeIssue: async () => {},
    }
    const out = await runMergeTask(
      { cfg, log: () => {}, gitea, dws: mkDws([], sends) },
      { key: "demo/demo#12", repo: "demo/demo", pr: 12, issue: 9, notifyTo: "boss", workflow: "review" }
    )
    assert.equal(out.ok, false)
    assert.equal(attempts, 1, "只试一次，不 force merge、不重试")
    assert.equal(sends.length, 0, "合并失败也只记账，不回执通知")
    assert.equal(new Book(cfg.stateFile).mergeAsk["demo/demo#12"].status, "failed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runMergeTask：没写 workflow 时按账本推断——自有工单落 own，别人的 PR 落 review", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    // 自有工单：账本里有派活痕迹（分支 / 工作区 / 执行会话）
    book.setIssue("demo/demo#9", { state: "pr-open", pr: 12, branch: "fix/issue-9", worktree: "/tmp/wt-9", agent: "conv-work" })
    const seen = []
    const engine = {
      paused: () => false,
      setPaused: () => {},
      emit: async (event, payload = {}) => { seen.push(`${event}:${payload.workflow ?? ""}`) },
      afterMerge: async ({ workflow }) => { seen.push(`afterMerge:${workflow}`); return { notes: [] } },
    }
    const gitea = { mergePr: async () => {}, closeIssue: async () => {}, viewPr: async () => null }
    const out = await runMergeTask(
      { cfg, log: () => {}, gitea, dws: mkDws([], []), engine },
      { key: "demo/demo#12", repo: "demo/demo", pr: 12, issue: 9, notify: false }
    )
    assert.equal(out.ok, true)
    assert.equal(seen.includes("pr.reviewed:review"), false, "自有工单的 PR 不该被记成「他人 PR」流程")
    // 关单事件由 close 节点在 engine.afterMerge 里发，service 不再重复发一遍。
    assert.equal(seen.includes("issue.closed:own"), false, "service 不该再自己发一次关单事件")
    assert.ok(seen.includes("afterMerge:own"))

    // 别人的 PR：账本里没有这张单的派活痕迹 → review
    const seen2 = []
    const engine2 = {
      paused: () => false,
      setPaused: () => {},
      emit: async (event, payload = {}) => { seen2.push(`${event}:${payload.workflow ?? ""}`) },
      afterMerge: async ({ workflow }) => { seen2.push(`afterMerge:${workflow}`); return { notes: [] } },
    }
    const out2 = await runMergeTask(
      { cfg, log: () => {}, gitea, dws: mkDws([], []), engine: engine2 },
      { key: "demo/demo#13", repo: "demo/demo", pr: 13 }
    )
    assert.equal(out2.ok, true)
    assert.ok(seen2.includes("pr.reviewed:review"), "别人的 PR 合并前先记「核对完」")
    assert.ok(seen2.includes("afterMerge:review"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runMergeTask：没传 --issue 时按 PR 反查工单，close 节点照样接到这张单", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    // 账本里 PR #122 挂在工单 #121（合并命令没带 --issue 的唯一线索）
    book.setIssue("demo/demo#121", { state: "pr-open", pr: 122, branch: "fix/issue-121" })
    const calls = []
    const engine = {
      paused: () => false,
      setPaused: () => {},
      emit: async () => {},
      issueKeyForPr: () => "demo/demo#121",
      afterMerge: async ({ watcher, workflow }) => {
        calls.push({ issueKey: watcher.issueKey, workflow })
        return { nodes: ["merge", "pr-open", "dispatch", "close"], notes: ["工单 #121 已关闭"] }
      },
    }
    const gitea = { mergePr: async () => {}, closeIssue: async () => {}, viewPr: async () => null }
    const out = await runMergeTask(
      { cfg, log: () => {}, gitea, dws: mkDws([], []), engine },
      { key: "demo/demo#122", repo: "demo/demo", pr: 122, notify: false }
    )
    assert.equal(out.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].issueKey, "demo/demo#121", "没带 --issue 也要接回这张单")
    assert.equal(calls[0].workflow, "own", "账本里有派活痕迹，按自有工单收尾")
    assert.ok(out.notes.some((n) => n.includes("#121")))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("completeIssue：远端已合并时不重复合并，复用 afterMerge 收尾", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("demo/demo#9", { state: "pr-open", pr: 12, branch: "fix/issue-9", worktree: "/tmp/wt-9" })
    book.setWatch({ target: "conv-work", name: "conv-work", issueKey: "demo/demo#9", repo: "demo/demo", number: 9 })
    let merges = 0
    const after = []
    const engine = {
      paused: () => false,
      setPaused: () => {},
      emit: async () => {},
      issueKeyForPr: () => "demo/demo#9",
      afterMerge: async ({ watcher, workflow }) => {
        after.push({ issueKey: watcher.issueKey, workflow })
        new Book(cfg.stateFile).setIssue("demo/demo#9", { state: "done" })
        return { nodes: ["close", "cleanup", "archive"], notes: ["已收尾"] }
      },
    }
    const gitea = {
      viewPr: async () => ({ state: "merged" }),
      mergePr: async () => { merges++ },
      closeIssue: async () => {},
    }
    const out = await completeIssue({ cfg, gitea, engine, dws: mkDws([], []), log: () => {} }, { repo: "demo/demo", number: 9 })
    assert.equal(out.ok, true)
    assert.equal(out.completed, true)
    assert.equal(merges, 0, "手动完成不能再发合并请求")
    assert.deepEqual(after, [{ issueKey: "demo/demo#9", workflow: "own" }])
    assert.equal(new Book(cfg.stateFile).issue("demo/demo#9").state, "done")
    assert.equal(new Book(cfg.stateFile).watch.some((w) => w.issueKey === "demo/demo#9"), false, "手动完成要摘掉该单监听")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("completeIssue：开放 PR 拒绝完成，也不触发合并或收尾", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir)
    new Book(cfg.stateFile).setIssue("demo/demo#9", { state: "pr-open", pr: 12 })
    let merges = 0
    let afterMerges = 0
    const out = await completeIssue({
      cfg,
      gitea: { viewPr: async () => ({ state: "open" }), mergePr: async () => { merges++ } },
      engine: { afterMerge: async () => { afterMerges++ } },
      log: () => {},
    }, { repo: "demo/demo", number: 9 })
    assert.equal(out.ok, false)
    assert.equal(out.error, "pr-not-merged")
    assert.equal(out.state, "open")
    assert.equal(merges, 0)
    assert.equal(afterMerges, 0)
    assert.equal(new Book(cfg.stateFile).issue("demo/demo#9").state, "pr-open")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("POST /api/complete：开放 PR 返回 409，不改变账本", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    new Book(cfg.stateFile).setIssue("demo/demo#9", { state: "pr-open", pr: 12 })
    let merges = 0
    const gitea = {
      listPulls: async () => [],
      viewPr: async () => ({ state: "open" }),
      mergePr: async () => { merges++ },
      closeIssue: async () => {},
    }
    server = await startServer({ cfg, dws: mkDws([], []), gitea, log: () => {} })
    const res = await fetch(`http://127.0.0.1:${server.port}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "demo/demo", number: 9 }),
    })
    const body = await res.json()
    assert.equal(res.status, 409)
    assert.equal(body.ok, false)
    assert.equal(body.error, "pr-not-merged")
    assert.equal(merges, 0)
    assert.equal(new Book(cfg.stateFile).issue("demo/demo#9").state, "pr-open")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
