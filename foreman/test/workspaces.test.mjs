// 一工程一工作区：工单跨工程时每个工程各一个 worktree、各一条 PR；收尾按工程粒度来，
// 所有工程的 PR 都合完才关单。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import {
  findWorkspace,
  issuePrs,
  mentionsRepo,
  mergeWorkspace,
  reposForIssue,
  upsertPr,
  workspacePath,
} from "../src/workspaces.mjs"
import { NODE_TEARDOWN, issueKeyForPr, prMerged } from "../src/workflow/cleaners.mjs"
import { runRound } from "../src/orchestrator.mjs"

const repos = [
  { name: "win-ai-harness", repo: "yyzl/win-ai-harness", dir: "/tmp/win-ai-harness", base: "sit-20261126", product: "win-ai-stack" },
  { name: "yyjz-oa-frontend", repo: "yyzl/yyjz-oa-frontend", dir: "/tmp/yyjz-oa-frontend", base: "sit-20261126", product: "win-ai-stack" },
  { name: "yyjz-oa-cloud", repo: "yyzl/yyjz-oa-cloud", dir: "/tmp/yyjz-oa-cloud", base: "sit-20261126", product: "win-ai-stack" },
  { name: "other-product", repo: "yyzl/other-product", dir: "/tmp/other", base: "sit-20261126", product: "别的产品" },
]

const primary = repos[0]

test("正文提到其它工程也不预建，默认只保留工单所在仓库", () => {
  const issue = { number: 284, title: "镜像页", body: "依赖 win-ai-harness/web 与 yyjz-oa-frontend/apps/admin，实际只改 win-ai-harness" }
  const out = reposForIssue(issue, repos, primary)
  assert.deepEqual(out.map((r) => r.repo), ["yyzl/win-ai-harness"])
})

test("显式 extraRepos 才增加工作区，支持工程名与 owner/name 并去重", () => {
  const issue = { number: 284, title: "镜像页", body: "" }
  const out = reposForIssue(issue, repos, primary, {
    extraRepos: ["yyjz-oa-frontend", "yyzl/yyjz-oa-frontend"],
  })
  assert.deepEqual(out.map((r) => r.repo), ["yyzl/win-ai-harness", "yyzl/yyjz-oa-frontend"])
})

test("别的产品的仓库不拉进来；没提到的工程不预建", () => {
  const issue = { number: 1, title: "other-product/web 也要改" }
  const out = reposForIssue(issue, repos, primary)
  assert.deepEqual(out.map((r) => r.repo), ["yyzl/win-ai-harness"])
})

test("显式工程必须在本产品配置内，写错名字不能静默漏建", () => {
  assert.throws(
    () => reposForIssue({}, repos, primary, { extraRepos: ["other-product"] }),
    /other-product.*不在本产品配置内/
  )
})

test("短仓库名只认 owner/name 或 <仓库名>/ 路径，避免 api/web 这类词误命中", () => {
  const short = { name: "api", repo: "yyzl/api" }
  assert.equal(mentionsRepo("顺手改一下 api 注释", short), false)
  assert.equal(mentionsRepo("改 api/admin 的页面", short), true)
  assert.equal(mentionsRepo("见 yyzl/api#12", short), true)
})

test("工作区路径按工程分：同一张单在两个仓库各一份", () => {
  assert.equal(workspacePath("/w", repos[0], "fix/issue-284"), "/w/win-ai-harness/fix-issue-284")
  assert.equal(workspacePath("/w", repos[1], "fix/issue-284"), "/w/yyjz-oa-frontend/fix-issue-284")
})

test("账本 workspaces：同工程覆盖、别的工程保留；老账本只认主仓库", () => {
  const a = mergeWorkspace([], { repo: "yyzl/win-ai-harness", worktree: "/w/a", branch: "fix/issue-284" })
  const b = mergeWorkspace(a, { repo: "yyzl/yyjz-oa-frontend", worktree: "/w/b", branch: "fix/issue-284" })
  const c = mergeWorkspace(b, { repo: "yyzl/win-ai-harness", worktree: "/w/a2", branch: "fix/issue-284" })
  assert.equal(c.length, 2)
  assert.equal(c[0].worktree, "/w/a2")

  assert.deepEqual(findWorkspace({ workspaces: c }, "yyzl/yyjz-oa-frontend").worktree, "/w/b")
  assert.equal(findWorkspace({ workspaces: c }, "yyzl/yyjz-oa-cloud"), null)
  // 老账本（没有 workspaces）：只回主仓库那条
  assert.equal(findWorkspace({ repo: "yyzl/win-ai-harness", worktree: "/w/old", branch: "fix/issue-1" }, "yyzl/win-ai-harness").worktree, "/w/old")
  assert.equal(findWorkspace({ repo: "yyzl/win-ai-harness", worktree: "/w/old", branch: "fix/issue-1" }, "yyzl/yyjz-oa-frontend"), null)
})

test("PR 记账：一个工程一条，同工程重开覆盖", () => {
  const a = upsertPr([], { repo: "yyzl/win-ai-harness", pr: 290, prUrl: "u1", branch: "fix/issue-284" })
  const b = upsertPr(a, { repo: "yyzl/yyjz-oa-frontend", pr: 300, prUrl: "u2", branch: "fix/issue-284" })
  assert.equal(b.length, 2)
  assert.deepEqual(issuePrs({ prs: b }).map((p) => p.pr), [290, 300])
})

test("收尾：只合了一个工程的 PR 就先不关单", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ws-close-"))
  try {
    const file = path.join(dir, "state.json")
    const b = new Book(file)
    b.setIssue("yyzl/win-ai-harness#284", {
      state: "pr-open",
      repo: "yyzl/win-ai-harness",
      workspaces: [
        { repo: "yyzl/win-ai-harness", worktree: "/w/a", branch: "fix/issue-284" },
        { repo: "yyzl/yyjz-oa-frontend", worktree: "/w/b", branch: "fix/issue-284" },
      ],
      prs: [
        { repo: "yyzl/win-ai-harness", pr: 290, prUrl: "u1", branch: "fix/issue-284" },
        { repo: "yyzl/yyjz-oa-frontend", pr: 300, prUrl: "u2", branch: "fix/issue-284" },
      ],
    })
    b.markMergeAsked("yyzl/win-ai-harness#290", { status: "merged" })

    let closed = 0
    const out = await NODE_TEARDOWN.close({
      tracker: { closeIssue: async () => { closed++ }, editLabels: async () => ({ changed: true }) },
      book: new Book(file),
      issueKey: "yyzl/win-ai-harness#284",
      repo: "yyzl/win-ai-harness",
      issueNo: 284,
      pr: 290,
    })
    assert.equal(closed, 0, "另一个工程的 PR 还没合，不能关单")
    assert.match(out.notes.join("\n"), /还有 1 个工程的 PR 没合/)
    assert.equal(new Book(file).issue("yyzl/win-ai-harness#284").state, "pr-open")

    // 第二个也合了：这次才关单
    b.markMergeAsked("yyzl/yyjz-oa-frontend#300", { status: "merged" })
    let closedRepo = ""
    await NODE_TEARDOWN.close({
      tracker: { closeIssue: async (repo) => { closedRepo = repo; closed++ }, editLabels: async () => ({ changed: true }) },
      book: new Book(file),
      issueKey: "yyzl/win-ai-harness#284",
      repo: "yyzl/yyjz-oa-frontend",
      issueNo: 284,
      pr: 300,
    })
    assert.equal(closed, 1)
    assert.equal(closedRepo, "yyzl/win-ai-harness", "关单关在工单所在仓库，不是 PR 仓库")
    assert.equal(new Book(file).issue("yyzl/win-ai-harness#284").state, "done")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("收尾：workspace 节点只清这次合并那条 PR 所属工程的工作区", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ws-clean-"))
  try {
    const file = path.join(dir, "state.json")
    const b = new Book(file)
    b.setIssue("yyzl/win-ai-harness#284", {
      repo: "yyzl/win-ai-harness",
      workspaces: [
        { repo: "yyzl/win-ai-harness", worktree: "/w/a", branch: "fix/issue-284" },
        { repo: "yyzl/yyjz-oa-frontend", worktree: "/w/b", branch: "fix/issue-284" },
      ],
    })
    const cleaned = []
    await NODE_TEARDOWN.workspace({
      book: new Book(file),
      issueKey: "yyzl/win-ai-harness#284",
      repo: "yyzl/yyjz-oa-frontend",
      cfg: { repos },
      workspace: { cleanup: async (args) => { cleaned.push(args); return { notes: ["worktree 已删除"] } } },
    })
    assert.equal(cleaned.length, 1)
    assert.equal(cleaned[0].worktree, "/w/b")
    assert.equal(cleaned[0].repoDir, "/tmp/yyjz-oa-frontend")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("按 PR 反查工单：PR 在别的仓库时靠账本 prs[] 找回工单键", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ws-key-"))
  try {
    const file = path.join(dir, "state.json")
    const b = new Book(file)
    b.setIssue("yyzl/win-ai-harness#284", {
      repo: "yyzl/win-ai-harness",
      prs: [
        { repo: "yyzl/win-ai-harness", pr: 290 },
        { repo: "yyzl/yyjz-oa-frontend", pr: 300 },
      ],
    })
    assert.equal(issueKeyForPr(b, "yyzl/yyjz-oa-frontend", 300), "yyzl/win-ai-harness#284")
    assert.equal(issueKeyForPr(b, "yyzl/yyjz-oa-frontend", 300, 284), "yyzl/win-ai-harness#284")
    assert.equal(prMerged(b, { repo: "yyzl/yyjz-oa-frontend", pr: 300 }), false)
    b.markMergeAsked("yyzl/yyjz-oa-frontend#300", { status: "merged" })
    assert.equal(prMerged(new Book(file), { repo: "yyzl/yyjz-oa-frontend", pr: 300 }), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
