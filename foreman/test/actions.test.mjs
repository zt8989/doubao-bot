// agent 的 PR / 工单写操作走 foreman：账本要记、控制台要能看到。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handleRequest } from "../src/service.mjs"
import { Book } from "../src/book.mjs"
import { ConsoleStore } from "../src/console.mjs"

function ctxOf(dir) {
  const created = []
  const gitea = {
    createPr: async ({ repo, base, head, title }) => {
      created.push({ kind: "pr", repo, base, head, title })
      return { number: 12, url: `http://gitea/${repo}/pulls/12` }
    },
    commentIssue: async (repo, n, body) => { created.push({ kind: "comment", repo, n, body }) },
    closeIssue: async (repo, n) => { created.push({ kind: "close", repo, n }) },
  }
  const cfg = { stateFile: path.join(dir, "state.json"), pickup: { me: "233151" } }
  const consoleStore = new ConsoleStore(path.join(dir, "console.db"))
  const ctx = { cfg, gitea, log: () => {}, consoleStore, state: {} }
  return { ctx, created, consoleStore }
}

test("pr open：建 PR 并记 prSeen + 工单转 pr-open，控制台立刻可见", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-pr-"))
  const { ctx, created, consoleStore } = ctxOf(dir)
  try {
    const r = await handleRequest(ctx, {
      id: "cli", cmd: "pr open",
      repo: "demo/demo", base: "sit-20261126", head: "fix/issue-9",
      title: "fix(#9): 改好了", body: "自证：测试通过", issue: 9,
    })
    assert.equal(r.ok, true)
    assert.equal(r.pr, 12)
    assert.equal(r.url, "http://gitea/demo/demo/pulls/12")

    const pr = new Book(cfgOf(dir)).prSeen["demo/demo#12"]
    assert.equal(pr.number, 12)
    assert.equal(pr.skipped, "self")
    assert.equal(new Book(cfgOf(dir)).issue("demo/demo#9").state, "pr-open")

    const snap = consoleStore.snapshot()
    assert.ok(snap.prs.some((p) => p.key === "demo/demo#12"), "控制台 prs 里能看到")
    assert.equal(snap.tasks.find((t) => t.key === "demo/demo#9").state, "pr-open")

    // 参数不全要直接报错，不落账
    const bad = await handleRequest(ctx, { id: "cli", cmd: "pr open", repo: "demo/demo", head: "x" })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, "bad-request")
    assert.equal(created.length, 1)
  } finally {
    consoleStore.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("issue comment / close 走 foreman 并记账", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-issue-"))
  const { ctx, created, consoleStore } = ctxOf(dir)
  try {
    const a = await handleRequest(ctx, { id: "cli", cmd: "issue comment", repo: "demo/demo", number: 9, body: "在改，预计今天好" })
    assert.equal(a.ok, true)
    assert.equal(a.commented, true)
    assert.equal(created[0].kind, "comment")
    assert.match(new Book(cfgOf(dir)).issue("demo/demo#9").note, /在改/)

    const b = await handleRequest(ctx, { id: "cli", cmd: "issue close", repo: "demo/demo", number: 9 })
    assert.equal(b.ok, true)
    assert.equal(b.closed, true)
    assert.equal(new Book(cfgOf(dir)).issue("demo/demo#9").state, "done")
    assert.equal(consoleStore.snapshot().tasks.find((t) => t.key === "demo/demo#9").state, "done")
  } finally {
    consoleStore.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("派活会话写进 tasks.agent，能按 agent 统计", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-agent-"))
  const book = new Book(path.join(dir, "state.json"))
  const store = new ConsoleStore(path.join(dir, "console.db"))
  try {
    book.setIssue("demo/demo#9", { state: "working", agent: "foreman-demo-9", title: "t" })
    store.sync(book)
    const row = store.snapshot().tasks.find((t) => t.key === "demo/demo#9")
    assert.equal(row.agent, "foreman-demo-9")
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function cfgOf(dir) {
  return path.join(dir, "state.json")
}
