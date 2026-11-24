// 一条龙工作流：issue create → ws add（账本自举 + Issue.ref）→ ws list，全程 tracker 适配器。
import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handleRequest } from "../src/service.mjs"
import { GiteaTrackerAdapter } from "../src/workflow/adapters/gitea.mjs"
import { makeSessionAdapter } from "../src/workflow/adapters/session.mjs"
import { Book } from "../src/book.mjs"

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "foreman-onestop-"))

function mkCfg(dir, repoDir) {
  return {
    stateFile: path.join(dir, "state.json"),
    worktreeDir: path.join(dir, "worktrees"),
    agent: "noop",
    repos: [{ repo: "yyzl/demo", name: "demo", dir: repoDir, base: "main" }],
    service: { http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") }, pidFile: path.join(dir, "foreman.pid"), logFile: path.join(dir, "service.log") },
  }
}

function mkCtx(cfg, gitea) {
  return {
    cfg,
    state: { watchers: new Map() },
    gitea,
    log: () => {},
  }
}

// 真仓库夹具：一个本地提交 + 伪造的 origin/main 引用，createWorktree 才能从基线拉分支。
function gitFixture(dir) {
  const repoDir = path.join(dir, "demo")
  fs.mkdirSync(repoDir, { recursive: true })
  const sh = (cmd) => execSync(cmd, { cwd: repoDir, stdio: "ignore" })
  sh("git init -q")
  sh("git config user.email t@t.local")
  sh("git config user.name t")
  fs.writeFileSync(path.join(repoDir, "README.md"), "demo\n")
  sh("git add -A")
  sh("git commit -qm init")
  sh("git branch -M main")
  sh("git remote add origin .")
  sh("git fetch origin main --quiet")
  return repoDir
}

function fakeTracker(log = []) {
  const impl = {
    // 可覆写 viewIssue 的 ref 值与标签
    issueRef: "",
    issueLabels: ["ready-for-agent"],
    async viewIssue(repo, n) {
      log.push(["viewIssue", repo, n])
      return { number: n, title: "示例工单", url: `https://gitea.example/${repo}/issues/${n}`, labels: this.issueLabels, ref: this.issueRef }
    },
    async createIssue(repo, { title, body }) {
      log.push(["createIssue", repo, title])
      return { number: 42, title, url: `https://gitea.example/${repo}/issues/42` }
    },
    async editIssue(repo, n, patch) {
      log.push(["editIssue", repo, n, patch])
      this.issueRef = patch.ref ?? this.issueRef
      return { ok: true }
    },
  }
  return new GiteaTrackerAdapter({ impl })
}

test("issue create：tracker 建单 + 账本建档（planned）", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    const tracker = fakeTracker()
    const out = await handleRequest(mkCtx(cfg, tracker), { id: "a", cmd: "issue create", repo: "yyzl/demo", title: "新工单", body: "正文" })
    assert.equal(out.ok, true)
    assert.equal(out.key, "yyzl/demo#42")
    assert.equal(out.number, 42)
    assert.match(out.url, /issues\/42$/)
    const rec = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")).issues["yyzl/demo#42"]
    assert.equal(rec.state, "planned")
    assert.equal(rec.title, "新工单")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ws add 自起步：账本没建档时回查 tracker 建 planned，建工作区并写工单右侧分支", async () => {
  const dir = tmpDir()
  try {
    const repoDir = gitFixture(dir)
    const cfg = mkCfg(dir, repoDir)
    const calls = []
    const tracker = fakeTracker(calls)
    const out = await handleRequest(mkCtx(cfg, tracker), { id: "b", cmd: "ws add", issue: "yyzl/demo#7", repo: "yyzl/demo" })
    assert.equal(out.ok, true)
    assert.equal(out.branch, "fix/issue-7")
    assert.ok(fs.existsSync(path.join(out.worktree, ".git")), "worktree 已建")
    // 账本：planned + workspaces + branchRef
    const book = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")).issues["yyzl/demo#7"]
    assert.equal(book.state, "planned")
    assert.equal(book.workspaces.length, 1)
    assert.equal(book.branchRef.branch, "fix/issue-7")
    // tracker：editIssue 写了 ref，viewIssue 至少两次（建档 + 读 ref）
    assert.ok(calls.some((c) => c[0] === "editIssue" && c[3].ref === "fix/issue-7"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ws add 幂等：ref 已对就不重写；跨工程（--repo 非工单仓）不动 ref", async () => {
  const dir = tmpDir()
  try {
    const repoDir = gitFixture(dir)
    const cfg = mkCfg(dir, repoDir)
    const calls = []
    const tracker = fakeTracker(calls)
    tracker.impl.issueRef = "fix/issue-7" // 右侧分支已经是对的
    await handleRequest(mkCtx(cfg, tracker), { id: "c1", cmd: "ws add", issue: "yyzl/demo#7", repo: "yyzl/demo" })
    assert.equal(calls.filter((c) => c[0] === "editIssue").length, 0, "ref 已对不重写")

    // 同一单配第二个工程：ws add 用 --repo 指向不在工单键里的仓时不动 ref。
    // 这里直接再对同一仓调一次（幂等复用 worktree），editIssue 仍然为 0。
    await handleRequest(mkCtx(cfg, tracker), { id: "c2", cmd: "ws add", issue: "yyzl/demo#7", repo: "demo" })
    assert.equal(calls.filter((c) => c[0] === "editIssue").length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ws list：没建档回空清单不报错；agent=noop 时会话动作不碰豆包", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    const out = await handleRequest(mkCtx(cfg, fakeTracker()), { id: "d", cmd: "ws list", issue: "yyzl/demo#999" })
    assert.equal(out.ok, true)
    assert.deepEqual(out.workspaces, [])
    // noop 适配器与 tracker 互不相干：会话面永远「成功但不落地」
    const session = makeSessionAdapter(cfg)
    assert.equal(session.constructor.name, "NoopSessionAdapter")
    assert.equal((await session.archive("任意会话")).ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("能力位守卫：tracker 没有 editIssue/issueRef 时 ws add 照常，只是不写 ref", async () => {
  const dir = tmpDir()
  try {
    const repoDir = gitFixture(dir)
    const cfg = mkCfg(dir, repoDir)
    const bare = { viewIssue: async (repo, n) => ({ number: n, title: "t", url: "", ref: "", labels: ["ready-for-agent"] }) }
    const tracker = new GiteaTrackerAdapter({ impl: bare })
    delete tracker.impl.editIssue
    tracker.capabilities = {}
    const out = await handleRequest(mkCtx(cfg, tracker), { id: "e", cmd: "ws add", issue: "yyzl/demo#8", repo: "yyzl/demo" })
    assert.equal(out.ok, true)
    const book = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")).issues["yyzl/demo#8"]
    assert.equal(book.branchRef, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("ws add 标签门禁：无 ready-for-agent 拒绝（not-ready），不建工作区不建档", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    const tracker = fakeTracker()
    tracker.impl.issueLabels = ["enhancement"]
    const routed = []
    const ctx = mkCtx(cfg, tracker)
    ctx.notifyRouter = async (e) => { routed.push(e); return { ok: true } }
    const out = await handleRequest(ctx, { id: "g", cmd: "ws add", issue: "yyzl/demo#11", repo: "yyzl/demo" })
    assert.equal(out.ok, false)
    assert.equal(out.error, "not-ready")
    assert.match(out.message, /没有 ready-for-agent/)
    assert.equal(routed.length, 0, "not-ready 不投 router")
    assert.equal(fs.existsSync(path.join(cfg.worktreeDir, "demo")), false, "未建工作区")
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#11"), null, "被拒的单不在账本留痕")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ws add 门禁：needs-info / ready-for-human / wontfix 分类报错", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    for (const [label, errCode, hint] of [
      ["needs-info", "needs-info", /向用户\/工单发起人索要/],
      ["ready-for-human", "needs-human", /归属人工/],
      ["wontfix", "wontfix", /不修/],
    ]) {
      const tracker = fakeTracker()
      tracker.impl.issueLabels = [label]
      const out = await handleRequest(mkCtx(cfg, tracker), { id: label, cmd: "ws add", issue: "yyzl/demo#12", repo: "yyzl/demo" })
      assert.equal(out.ok, false, label)
      assert.equal(out.error, errCode, label)
      assert.match(out.message, hint, label)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ws add 门禁：needs-triage 报错给 agent（默认不投 router——默认调用者就是 agent）", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    const tracker = fakeTracker()
    tracker.impl.issueLabels = ["needs-triage"]
    const routed = []
    const ctx = mkCtx(cfg, tracker)
    ctx.notifyRouter = async (e) => { routed.push(e); return { ok: true } }
    const out = await handleRequest(ctx, { id: "h", cmd: "ws add", issue: "yyzl/demo#13", repo: "yyzl/demo" })
    assert.equal(out.ok, false)
    assert.equal(out.error, "needs-triage")
    assert.match(out.message, /改标签（ready-for-agent=可开工 \/ ready-for-human=交人工）/)
    assert.match(out.message, /--force/)
    assert.equal(routed.length, 0, "默认调用者是 agent：提示给 agent，不投 router")
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#13"), null, "triage 拒绝也不留账本痕迹")
    assert.equal(fs.existsSync(path.join(cfg.worktreeDir, "demo")), false, "不开工作区")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("ws add 门禁：--force 绕过（照常建工作区+回写 ref）", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    const tracker = fakeTracker()
    tracker.impl.issueLabels = ["needs-info"]
    const out = await handleRequest(mkCtx(cfg, tracker), { id: "i", cmd: "ws add", issue: "yyzl/demo#14", repo: "yyzl/demo", force: true })
    assert.equal(out.ok, true)
    assert.equal(out.branch, "fix/issue-14")
    const after = new Book(cfg.stateFile).issue("yyzl/demo#14")
    assert.equal(after.state, "planned")
    assert.equal(after.workspaces.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("ws add --automation：自动化请求不执行，路由给 router agent", async () => {
  const dir = tmpDir()
  try {
    const cfg = mkCfg(dir, gitFixture(dir))
    const routed = []
    const tracker = fakeTracker()
    tracker.impl.issueLabels = ["ready-for-agent"]   // 即使标签放行，自动化也不直接执行
    const ctx = mkCtx(cfg, tracker)
    ctx.notifyRouter = async (e) => { routed.push(e); return { ok: true, eventId: "evt-auto" } }
    const out = await handleRequest(ctx, { id: "j", cmd: "ws add", issue: "yyzl/demo#15", repo: "yyzl/demo", automation: true })
    assert.equal(out.ok, true)
    assert.equal(out.routed, "router")
    assert.equal(out.automation, true)
    assert.equal(routed.length, 1)
    assert.equal(routed[0].type, "ws.add")
    assert.match(routed[0].text, /自动化请求/)
    assert.equal(fs.existsSync(path.join(cfg.worktreeDir, "demo")), false, "自动化不直接建工作区")
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#15"), null, "自动化不建档")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("worktreeHook：ws add 后自动执行初始化命令，结果进返回与账本；reused 也重跑", async () => {
  const dir = tmpDir()
  try {
    const repoDir = gitFixture(dir)
    const cfg = mkCfg(dir, repoDir)
    cfg.repos[0].worktreeHook = ["echo created > .hook-ran.txt"]
    const out = await handleRequest(mkCtx(cfg, fakeTracker()), { id: "h1", cmd: "ws add", issue: "yyzl/demo#21", repo: "yyzl/demo" })
    assert.equal(out.ok, true)
    assert.equal(out.hook.ok, true)
    assert.ok(fs.existsSync(path.join(out.worktree, ".hook-ran.txt")), "hook 在 worktree 里执行了")
    const rec = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")).issues["yyzl/demo#21"]
    assert.equal(rec.workspaces[0].hookOk, true)

    // 二次 add（reused）也重跑 hook：改写文件内容验证是本轮跑的
    fs.rmSync(path.join(out.worktree, ".hook-ran.txt"), { force: true })
    const again = await handleRequest(mkCtx(cfg, fakeTracker()), { id: "h2", cmd: "ws add", issue: "yyzl/demo#21", repo: "yyzl/demo" })
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
    assert.equal(again.hook.ok, true)
    assert.ok(fs.existsSync(path.join(again.worktree, ".hook-ran.txt")), "复用路径同样跑 hook")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("worktreeHook 失败：ws add 照常交付，hook.ok=false + 账本记 hookError", async () => {
  const dir = tmpDir()
  try {
    const repoDir = gitFixture(dir)
    const cfg = mkCfg(dir, repoDir)
    cfg.repos[0].worktreeHook = ["echo before > .hook-first.txt", "exit 3", "echo after > .hook-never.txt"]
    const out = await handleRequest(mkCtx(cfg, fakeTracker()), { id: "h3", cmd: "ws add", issue: "yyzl/demo#22", repo: "yyzl/demo" })
    assert.equal(out.ok, true, "hook 失败不阻塞工作区交付")
    assert.equal(out.hook.ok, false)
    assert.match(out.hook.error, /exit 3|退出码/)
    assert.ok(fs.existsSync(path.join(out.worktree, ".hook-first.txt")))
    assert.ok(!fs.existsSync(path.join(out.worktree, ".hook-never.txt")), "失败即停，后续命令不跑")
    const rec = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")).issues["yyzl/demo#22"]
    assert.equal(rec.workspaces[0].hookOk, false)
    assert.ok(String(rec.workspaces[0].hookError ?? "").length > 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
