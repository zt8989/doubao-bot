// 合并后的本地收尾：herdr 工作区关闭 + worktree 删除 + 本地分支安全删除。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { cleanupMergedWorktree } from "../src/gitx.mjs"
import { notifyText } from "../src/orchestrator.mjs"

function sh(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

// 造一个真仓库 + 一个 linked worktree，herdr 用临时 node 脚本顶替（list 吐固定 JSON，close 记日志）。
// 用 .mjs：exec 按扩展名换起 node，Windows 不认 shebang 也能跑。
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-cleanup-"))
  const repo = path.join(dir, "repo")
  fs.mkdirSync(repo)
  sh(repo, ["init", "-q"])
  sh(repo, ["config", "user.email", "t@example.com"])
  sh(repo, ["config", "user.name", "t"])
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n")
  sh(repo, ["add", "."])
  sh(repo, ["commit", "-qm", "init"])
  const base = sh(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() // 老版本 git 没有 init -b
  const wt = path.join(dir, "wt", "fix-issue-1")
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  sh(repo, ["worktree", "add", "-q", "-b", "fix/issue-1", wt, base])

  const closedLog = path.join(dir, "closed.log")
  const fake = path.join(dir, "fake-herdr.mjs")
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs"
const [, , a, b] = process.argv
if (a === "workspace" && b === "list") {
  process.stdout.write(JSON.stringify({ id: "cli", result: { workspaces: [{ workspace_id: "wX1", label: "fix-issue-1", worktree: { checkout_path: ${JSON.stringify(wt)} } }] } }))
}
if (a === "workspace" && b === "close") {
  fs.appendFileSync(${JSON.stringify(closedLog)}, process.argv[4] + "\\n")
}
`)
  fs.chmodSync(fake, 0o755)
  return { dir, repo, wt, fake, closedLog }
}

test("合并后：herdr 工作区按 checkout_path 匹配关闭，worktree 与本地分支都清掉", async () => {
  const { dir, repo, wt, fake, closedLog } = fixture()
  try {
    const out = await cleanupMergedWorktree({ repoDir: repo, worktree: wt, branch: "fix/issue-1", herdrBin: fake })
    assert.equal(out.herdrClosed, true)
    assert.equal(fs.readFileSync(closedLog, "utf8").trim(), "wX1")
    assert.equal(out.worktreeRemoved, true)
    assert.equal(fs.existsSync(wt), false)
    assert.equal(out.branchDeleted, true)
    assert.ok(!sh(repo, ["branch", "--list", "fix/issue-1"]).includes("fix/issue-1"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("worktree 有未提交改动：保留并写清原因，不 force 删除", async () => {
  const { dir, repo, wt } = fixture()
  try {
    fs.writeFileSync(path.join(wt, "dirty.txt"), "没提交\n")
    const out = await cleanupMergedWorktree({ repoDir: repo, worktree: wt, branch: "fix/issue-1", useHerdr: false })
    assert.equal(out.worktreeRemoved, false)
    assert.equal(fs.existsSync(wt), true)
    assert.match(out.notes.join("；"), /保留/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("没有 worktree 记录：只说明跳过，不报错", async () => {
  const out = await cleanupMergedWorktree({ repoDir: "/tmp", worktree: "", useHerdr: false })
  assert.match(out.notes.join(""), /跳过本地清理/)
})

test("notifyText：合并通知带清理结果与 RESULT 块，方便归档会话", () => {
  const text = notifyText(
    { repo: "yyzl/win-ai-harness", number: 268 },
    {
      state: "done",
      session: "conv-1",
      pr: 270,
      prUrl: "http://x/pulls/270",
      merged: true,
      cleanup: { notes: ["herdr 工作区 fix-issue-268 已关闭", "worktree 已删除"] },
    }
  )
  assert.match(text, /清理：herdr 工作区 fix-issue-268 已关闭；worktree 已删除/)
  const m = text.match(/<RESULT>(.*)<\/RESULT>/)
  assert.ok(m, "合并通知必须带 RESULT")
  const r = JSON.parse(m[1])
  assert.equal(r.status, "done")
  assert.equal(r.merged, true)
  assert.equal(r.pr, 270)
  assert.deepEqual(r.cleanup, ["herdr 工作区 fix-issue-268 已关闭", "worktree 已删除"])
})
