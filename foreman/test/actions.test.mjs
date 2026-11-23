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
    mergePr: async (repo, n, opts) => { created.push({ kind: "merge", repo, n, opts }) },
    viewPr: async () => ({ state: "open", mergeNote: "" }),
    editLabels: async (repo, n, opts) => { created.push({ kind: "label", repo, n, opts }) },
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
    // 约定：PR 开出来就把 ready-for-agent 换成 ready-for-human
    const label = created.find((c) => c.kind === "label")
    assert.deepEqual(label, {
      kind: "label", repo: "demo/demo", n: 9,
      opts: { add: "ready-for-human", remove: "ready-for-agent" },
    })

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
    assert.equal(created.filter((c) => c.kind === "pr").length, 1)
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

test("pr open：不传 base 时取配置 repos[].base", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-pr-"))
  const created = []
  const consoleStore = new ConsoleStore(path.join(dir, "console.db"))
  const ctx = {
    cfg: {
      stateFile: path.join(dir, "state.json"),
      pickup: { me: "233151" },
      repos: [{ repo: "demo/demo", base: "sit-20261126" }],
    },
    state: {},
    consoleStore,
    log: () => {},
    gitea: {
      createPr: async ({ repo, base, head, title }) => {
        created.push({ repo, base, head, title })
        return { number: 14, url: `http://gitea/${repo}/pulls/14` }
      },
    },
  }
  try {
    const r = await handleRequest(ctx, { id: "cli", cmd: "pr open", repo: "demo/demo", head: "fix/x", title: "改好了" })
    assert.equal(r.ok, true)
    assert.equal(created[0].base, "sit-20261126", "基线来自配置，不在 CLI 写死")
  } finally {
    consoleStore.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pr merge：合并成功、可选关单，账本记 merged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-merge-"))
  const { ctx, created, consoleStore } = ctxOf(dir)
  try {
    // pr-open 节点只记 prSeen，不建档：先按真实链路预置工单记录（pr open 时建的）。
    new Book(cfgOf(dir)).setIssue("demo/demo#9", { state: "pr-open", repo: "demo/demo", prs: [{ repo: "demo/demo", pr: 12, branch: "fix/issue-9" }] })
    const r = await handleRequest(ctx, { id: "cli", cmd: "pr merge", repo: "demo/demo", number: 12, issue: 9 })
    assert.equal(r.ok, true)
    assert.equal(r.merged, true)
    assert.equal(r.issue, 9)
    // 同步回包要能直接当结论用：合并-only（关单清尾归 clean）、一行 summary、耗时。
    assert.equal(r.issueKey, "demo/demo#9")
    assert.equal(r.closed, false)
    assert.equal(r.awaitingClean, true)
    assert.equal(r.style, "merge")
    assert.match(r.where, /工程 demo\/demo/)
    assert.match(r.summary, /已合并 demo\/demo#12/)
    assert.match(r.summary, /demo\/demo#9 待 clean 关单收尾/)
    assert.equal(typeof r.elapsedMs, "number")
    assert.equal(created.find((c) => c.kind === "merge").opts.style, "merge")
    assert.equal(created.some((c) => c.kind === "close"), false, "merge 不再关单")
    assert.equal(new Book(cfgOf(dir)).mergeAsk["demo/demo#12"].status, "merged")
    assert.equal(new Book(cfgOf(dir)).issue("demo/demo#9").state, "pr-open")
    assert.ok(consoleStore.snapshot().tasks.some((t) => t && t.key === "demo/demo#9" && t.state === "pr-open"))
  } finally {
    consoleStore.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pr merge：合不了回理由（pr-merge 报错 + mergeNote）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-merge-"))
  const consoleStore = new ConsoleStore(path.join(dir, "console.db"))
  const ctx = {
    cfg: { stateFile: path.join(dir, "state.json"), pickup: { me: "233151" } },
    state: {},
    consoleStore,
    log: () => {},
    gitea: {
      mergePr: async () => { throw new Error("此分支存在冲突，无法自动合并") },
      viewPr: async () => ({ state: "open", mergeNote: "目标分支有新提交，需要先 rebase" }),
    },
  }
  try {
    const r = await handleRequest(ctx, { id: "cli", cmd: "pr merge", repo: "demo/demo", number: 13 })
    assert.equal(r.ok, false)
    assert.equal(r.error, "merge-failed")
    assert.match(r.message, /存在冲突/)
    assert.match(r.message, /需要先 rebase/)
    assert.equal(new Book(cfgOf(dir)).mergeAsk["demo/demo#13"].status, "failed")
  } finally {
    consoleStore.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
