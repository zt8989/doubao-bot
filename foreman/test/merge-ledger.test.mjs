// 合并收尾：PR 合并（含「已经合并」这种假失败）之后，账本要一次收干净——
// 工单进 done、PR 从「待合并」摘出来、执行会话监听摘掉、worktree/分支本地清理。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { finishMergedPr } from "../src/service.mjs"

const tmpBook = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-merge-"))
  return { dir, file: path.join(dir, "state.json") }
}

const seed = (file) => {
  const b = new Book(file)
  b.setWatch({ target: "38453031255662594", name: "foreman-yyjz-oa-frontend-228", issueKey: "yyzl/yyjz-oa-frontend#228", repo: "yyzl/yyjz-oa-frontend", number: 228 })
  b.setWatch({ target: "38453235018998530", name: "foreman-yyjz-oa-frontend-228b", issueKey: "yyzl/yyjz-oa-frontend#228", repo: "yyzl/yyjz-oa-frontend", number: 228 })
  b.setWatch({ target: "38453301376290562", name: "别的单", issueKey: "yyzl/win-ai-harness#268", repo: "yyzl/win-ai-harness", number: 268 })
  b.markPrSeen("yyzl/yyjz-oa-frontend#234", {
    repo: "yyzl/yyjz-oa-frontend", number: 234, title: "fix(#228)", skipped: "self", notifiedTo: "foreman-PR待合并", notifiedAt: "2026-11-12T03:30:27.000Z",
  })
  b.setIssue("yyzl/yyjz-oa-frontend#228", {
    state: "pr-open", issue: 228, pr: 234, branch: "fix/issue-228",
    worktree: "/tmp/nowhere/fix-issue-228",
  })
  return b
}

test("合并收尾：工单进 done、PR 摘出待合并、该单监听摘掉、别的单不动", async () => {
  const { file } = tmpBook()
  seed(file)
  const calls = { close: [], cleanup: [] }
  const out = await finishMergedPr({
    gitea: { closeIssue: async (repo, n) => { calls.close.push(`${repo}#${n}`) } },
    cfg: { stateFile: file, repos: [{ repo: "yyzl/yyjz-oa-frontend", dir: "/tmp/repo" }] },
    stateFile: file,
    repo: "yyzl/yyjz-oa-frontend",
    number: 234,
    issueNo: 228,
    cleanup: async (args) => { calls.cleanup.push(args); return { notes: ["worktree 已删除"] } },
  })

  const b = new Book(file)
  assert.deepEqual(calls.close, ["yyzl/yyjz-oa-frontend#228"])
  assert.equal(b.issue("yyzl/yyjz-oa-frontend#228").state, "done")
  assert.equal(b.prSeen["yyzl/yyjz-oa-frontend#234"].skipped, "merged")
  assert.equal(b.prSeen["yyzl/yyjz-oa-frontend#234"].merged, true)
  assert.equal(b.mergeAsk["yyzl/yyjz-oa-frontend#234"].status, "merged")

  const left = b.watch.map((w) => w.issueKey)
  assert.deepEqual(left, ["yyzl/win-ai-harness#268"])
  assert.equal(calls.cleanup.length, 1)
  assert.equal(calls.cleanup[0].worktree, "/tmp/nowhere/fix-issue-228")
  assert.equal(calls.cleanup[0].branch, "fix/issue-228")
  assert.equal(calls.cleanup[0].repoDir, "/tmp/repo")
  assert.deepEqual(out.notes, ["摘掉 2 条执行会话监听", "worktree 已删除"])
})

test("PR 已经合并（EMPTY_RESULT 假失败）也按已合并收尾，不卡成 failed", async () => {
  const { file } = tmpBook()
  seed(file)
  const out = await finishMergedPr({
    gitea: { closeIssue: async () => { throw new Error('opencli gitea close 失败：{"ok":false,"error":{"hint":"工单已经是关闭状态，无需重复关闭"}}') } },
    cfg: { stateFile: file, repos: [] },
    stateFile: file,
    repo: "yyzl/yyjz-oa-frontend",
    number: 234,
    issueNo: 228,
    alreadyMerged: true,
    cleanup: async () => ({ notes: [] }),
  })

  const b = new Book(file)
  assert.equal(b.mergeAsk["yyzl/yyjz-oa-frontend#234"].status, "merged")
  assert.equal(b.issue("yyzl/yyjz-oa-frontend#228").state, "done")
  assert.ok(out.notes.some((n) => n.includes("早已关闭")))
})
