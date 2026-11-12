// 自动合并：会话 done + 带 PR + 有自证 → 由编排（foreman）自己合并，不再让执行会话去合。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mergeDecision, startServer, runMergeTask } from "../src/service.mjs"
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

test("poll：done+PR 只把 PR 记下来、不再自动入队合并；通知让编排自己 foreman pr merge", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-work", name: "foreman-demo-9", issueKey: "demo/demo#9", repo: "demo/demo", number: 9, notifyTo: "boss" })

    const sends = []
    const merged = []
    const closed = []
    const gitea = {
      listPulls: async () => [],
      mergePr: async (repo, pr, opts) => { merged.push({ repo, pr, opts }) },
      closeIssue: async (repo, n) => { closed.push({ repo, n }) },
    }
    server = await startServer({ cfg, book, dws: mkDws([JSON.stringify(doneResult)], sends), gitea, log: () => {} })

    // 合并通道已取消：poll 不入队、也不合并，只把「PR 已开好」记进账本并通知编排。
    const r1 = await server.poll()
    assert.equal(r1.queued, undefined, "不再有合并队列")
    const note = sends.find((s) => s.target === "boss")
    assert.match(note.text, /合并：PR 已开好/)
    assert.match(note.text, /foreman pr merge 12/)
    assert.equal(merged.length, 0, "poll 不合并")
    const rec = new Book(cfg.stateFile).issue("demo/demo#9")
    assert.equal(rec.state, "pr-open")
    assert.equal(rec.pr, 12)

    // 编排核对后手动合：runMergeTask 直接执行，合完关单并回一条「合并完成」。
    const out = await runMergeTask(
      { cfg, log: () => {}, gitea, dws: mkDws([], sends) },
      { key: "demo/demo#12", repo: "demo/demo", pr: 12, issue: 9, notifyTo: "boss", workflow: "own" }
    )
    assert.equal(out.ok, true)
    assert.deepEqual(merged[0], { repo: "demo/demo", pr: 12, opts: { style: "merge", deleteBranch: true } })
    assert.deepEqual(closed, [{ repo: "demo/demo", n: 9 }])
    const mergeNote = sends.filter((s) => s.target === "boss").find((s) => /合并：已合并 PR #12/.test(s.text))
    assert.ok(mergeNote, "合并结果单独通知调用方")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runMergeTask：冲突 → 不 force merge、只记失败、调用方收到「合并失败」", async () => {
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
    const note = sends.filter((s) => s.target === "boss").find((s) => /合并失败：此分支存在冲突/.test(s.text))
    assert.ok(note, "合并失败要单独告诉调用方")
    assert.equal(new Book(cfg.stateFile).mergeAsk["demo/demo#12"].status, "failed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
