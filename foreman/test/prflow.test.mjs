// 工作会话只 commit 就收工：push 与开 PR 由 foreman 补（PR 号/链接进账本）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { openPrsForIssue } from "../src/prflow.mjs"

function tmpCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-prflow-"))
  return {
    stateFile: path.join(dir, "state.json"),
    repos: [{ repo: "yyzl/demo", name: "demo", dir: "/repo/demo", base: "sit-20261126" }],
    pickup: { me: "zhouteng" },
  }
}

function seedIssue(cfg, over = {}) {
  const b = new Book(cfg.stateFile)
  b.setIssue("yyzl/demo#7", {
    repo: "yyzl/demo",
    issue: 7,
    title: "修一下登录",
    state: "working",
    workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-7", base: "sit-20261126", worktree: "/wt/demo/fix-issue-7" }],
    ...over,
  })
}

function fakeDeps({ dirty = "", ahead = 1, prNumber = 12 } = {}) {
  const calls = { pushed: [], created: [] }
  const git = {
    statusPorcelain: async () => dirty,
    commitsAhead: async () => ahead,
    recentCommits: async () => "abc123 fix(#7): 修一下登录",
    diffStat: async () => " src/login.ts | 2 +-",
    pushBranch: async (wt, branch) => {
      calls.pushed.push({ wt, branch })
    },
  }
  const gitea = {
    createPr: async (arg) => {
      calls.created.push(arg)
      return { number: prNumber, url: `http://gitea/pulls/${prNumber}` }
    },
  }
  return { calls, git, gitea }
}

test("工作区干净且有提交：foreman 自己 push 分支并开 PR，账本记 prs[]", async () => {
  const cfg = tmpCfg()
  seedIssue(cfg)
  const { calls, git, gitea } = fakeDeps()
  const out = await openPrsForIssue({ cfg, git, gitea, log: () => {} }, { issueKey: "yyzl/demo#7", summary: "修了登录校验", tests: "npm test 通过" })
  assert.equal(out.prs.length, 1)
  assert.deepEqual(calls.pushed, [{ wt: "/wt/demo/fix-issue-7", branch: "fix/issue-7" }])
  assert.equal(calls.created[0].head, "fix/issue-7")
  assert.equal(calls.created[0].base, "sit-20261126")
  assert.match(calls.created[0].body, /Closes #7/)
  assert.match(calls.created[0].body, /npm test 通过/)
  const rec = new Book(cfg.stateFile).issue("yyzl/demo#7")
  assert.equal(rec.state, "pr-open")
  assert.equal(rec.pr, 12)
  assert.equal(rec.prs[0].branch, "fix/issue-7")
})

test("工作区还有未提交改动：不开 PR，把原因说出来（当失败交给编排 resume）", async () => {
  const cfg = tmpCfg()
  seedIssue(cfg)
  const { calls, git, gitea } = fakeDeps({ dirty: " M src/login.ts" })
  const out = await openPrsForIssue({ cfg, git, gitea, log: () => {} }, { issueKey: "yyzl/demo#7" })
  assert.equal(out.prs.length, 0)
  assert.equal(calls.pushed.length, 0)
  assert.equal(calls.created.length, 0)
  assert.match(out.notes.join(), /未提交改动/)
})

test("分支上没有新提交：不开 PR", async () => {
  const cfg = tmpCfg()
  seedIssue(cfg)
  const { calls, git, gitea } = fakeDeps({ ahead: 0 })
  const out = await openPrsForIssue({ cfg, git, gitea, log: () => {} }, { issueKey: "yyzl/demo#7" })
  assert.equal(out.prs.length, 0)
  assert.equal(calls.created.length, 0)
  assert.match(out.notes.join(), /没有新提交/)
})

test("账本里没有这条单：直接回 unknown-issue", async () => {
  const cfg = tmpCfg()
  const { git, gitea } = fakeDeps()
  const out = await openPrsForIssue({ cfg, git, gitea, log: () => {} }, { issueKey: "yyzl/demo#99" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "unknown-issue")
})
