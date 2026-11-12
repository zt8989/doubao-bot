// 自动合并：会话 done + 带 PR + 有自证 → 由编排（foreman）自己合并，不再让执行会话去合。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mergeDecision, startServer } from "../src/service.mjs"
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

test("poll：done+PR 只入合并队列，合并通道合一次、关单，结果通知调用方", async () => {
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

    // poll 不再自己合并：只入队，通知里就说「已排入合并通道」。
    const r1 = await server.poll()
    assert.equal(r1.queued, 1)
    assert.equal(r1.merged, undefined, "poll 不做 20–40s 的合并，先返回")
    const queuedNote = sends.find((s) => s.target === "boss")
    assert.match(queuedNote.text, /合并：已排入合并通道/)

    // 合并通道（1 并发）取队列合掉。
    await server.merge()
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0], { repo: "demo/demo", pr: 12, opts: { style: "merge", deleteBranch: true } })
    assert.deepEqual(closed, [{ repo: "demo/demo", n: 9 }])

    const mergeNote = sends.filter((s) => s.target === "boss").find((s) => /合并：已合并 PR #12/.test(s.text))
    assert.ok(mergeNote, "合并结果单独通知调用方")

    // 同一 PR 换指纹再来一轮：不再合。
    await server.close()
    server = null
    const book2 = new Book(cfg.stateFile)
    book2.markNotified("conv-work", "other-fingerprint", {})
    server = await startServer({ cfg, book: book2, dws: mkDws([JSON.stringify({ ...doneResult, summary: "又补一句" })], sends), gitea, log: () => {} })
    await server.poll()
    await server.merge()
    assert.equal(merged.length, 1, "同一 PR 只合一次")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("poll：合并冲突 → 不 force merge、只记失败、调用方收到“合并失败”", async () => {
  const dir = tmpDir()
  let server
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-work", name: "foreman-demo-9", issueKey: "demo/demo#9", repo: "demo/demo", number: 9, notifyTo: "boss" })

    const sends = []
    let attempts = 0
    const gitea = {
      listPulls: async () => [],
      mergePr: async () => { attempts++; throw new Error("此分支存在冲突，无法自动合并") },
      closeIssue: async () => {},
    }
    server = await startServer({ cfg, book, dws: mkDws([JSON.stringify(doneResult)], sends), gitea, log: () => {} })

    const r = await server.poll()
    assert.equal(r.queued, 1)
    await server.merge()
    assert.equal(attempts, 1, "合并通道只试一次，不 force merge、不重试")
    const note = sends.filter((s) => s.target === "boss").find((s) => /合并失败：此分支存在冲突/.test(s.text))
    assert.ok(note, "合并失败要单独告诉调用方")
    assert.equal(new Book(cfg.stateFile).mergeAsk["demo/demo#12"].status, "failed")
    assert.equal(new Book(cfg.stateFile).mergeTask("demo/demo#12").status, "failed")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
