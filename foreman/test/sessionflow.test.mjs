// 以编排会话为中心：全程只有一条编排会话，工作会话绑在它身上；
// 更新用 steer 插进编排会话，失败也在同一条工作会话里续跑；合并关单后 clean。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { runRound } from "../src/orchestrator.mjs"
import {
  cleanIssue,
  ensureOrchestrator,
  handToOrchestrator,
  nextStepLine,
  orchestratorTarget,
  resumeWorker,
  sessionFlowEnabled,
  steerOrchestrator,
  workerOf,
} from "../src/sessionflow.mjs"
import { pollOnce } from "../src/service.mjs"

function mkRepo(dir, name) {
  const repoDir = path.join(dir, name)
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(repoDir, ".git"), "gitdir: .\n")
  return { name, repo: `yyzl/${name}`, dir: repoDir, base: "sit-20261126", verify: [], labels: null }
}

function mkCfg(dir) {
  return {
    stateFile: path.join(dir, "state.json"),
    worktreeDir: path.join(dir, "worktrees"),
    pollSeconds: 20,
    timeoutMinutes: 90,
    maxAttempts: 3,
    perRepoPerRound: 1,
    sessionFlow: { enabled: true, name: "", promptFile: "", projectDir: "" },
    pickup: { labelIds: [1], labels: [], excludeLabels: [], onlyUnassigned: false, order: "oldest", handToOrchestrator: false },
    herdr: { bin: "herdr", enabled: false },
    merge: { enabled: false },
    notify: { enabled: true, session: "boss", events: [] },
  }
}

// fake dws：记下每一类调用，够断言「开没开新会话、steer 到哪」。
function mkDws() {
  const calls = { openNew: [], open: [], send: [], steer: [], archive: [] }
  return {
    calls,
    openNew: async (args) => {
      calls.openNew.push(args)
      return { convId: `conv-worker-${calls.openNew.length}` }
    },
    open: async (args) => {
      calls.open.push(args)
      return { convId: "conv-open" }
    },
    send: async (name, text) => {
      calls.send.push({ name, text })
    },
    steer: async (target, text) => {
      calls.steer.push({ target, text })
    },
    archive: async (target) => {
      calls.archive.push(target)
    },
  }
}

test("编排会话幂等：账本里已有 convId 就复用，绝不开第二条", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-orch-"))
  try {
    const cfg = mkCfg(dir)
    const dws = mkDws()
    const ctx = { cfg, dws, log: () => {} }
    const first = await ensureOrchestrator(ctx)
    assert.equal(first.created, true)
    assert.equal(dws.calls.openNew.length, 1)
    assert.match(dws.calls.openNew[0].name, /编排/)
    assert.match(dws.calls.openNew[0].prompt, /agent 主动 dispatch 不限在跑上限/)
    assert.ok(!dws.calls.openNew[0].prompt.includes("同时在跑最多"))
    assert.equal(dws.calls.openNew[0].noWait, true)

    const second = await ensureOrchestrator(ctx)
    assert.equal(second.reused, true)
    assert.equal(second.convId, first.convId)
    assert.equal(dws.calls.openNew.length, 1, "第二次不该再开会话")

    const book = new Book(cfg.stateFile)
    assert.equal(orchestratorTarget(book), first.convId)
    assert.equal(book.session(first.name).kind, "orchestrator")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("hand：起编排会话并把工单 steer 进去，账本记 handed（不建工作区）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-hand-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const dws = mkDws()
    const issue = { number: 7, title: "镜像页", body: "改 demo 的镜像页" }
    const ctx = { cfg, dws, log: () => {}, gitea: { viewIssue: async () => issue } }

    const out = await handToOrchestrator(ctx, { repoCfg: repo, issue })
    assert.equal(out.state, "handed")
    assert.ok(out.convId)
    assert.equal(dws.calls.steer.length, 1)
    assert.equal(dws.calls.steer[0].target, out.convId)
    assert.match(dws.calls.steer[0].text, /工单键：yyzl\/demo#7/)
    assert.match(dws.calls.steer[0].text, /foreman dispatch --issue yyzl\/demo#7/)

    const rec = new Book(cfg.stateFile).issue("yyzl/demo#7")
    assert.equal(rec.state, "handed")
    assert.equal(rec.orchestrator, out.convId)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("dispatch：工作会话 id 绑到编排会话（账本 + 会话记录都要对得上）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-dispatch-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    // 预置 worktree，让 createWorktree 走 reused，不碰真实 git。
    const wt = path.join(cfg.worktreeDir, repo.name, "fix-issue-7")
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: .\n")

    const issue = { number: 7, title: "镜像页", body: "", labels: [], assignees: [], url: "" }
    const dws = mkDws()
    const ctx = {
      cfg,
      book: new Book(cfg.stateFile),
      dws,
      log: () => {},
      once: true,
      dryRun: false,
      gitea: {
        listIssues: async () => [issue],
        viewIssue: async (r, n) => ({ ...issue, number: n }),
        commentIssue: async () => ({}),
        editLabels: async () => ({}),
      },
    }

    const out = await runRound(ctx)
    assert.equal(out.length, 1)
    assert.equal(out[0].state, "dispatched")
    const key = "yyzl/demo#7"
    const book = new Book(cfg.stateFile)
    const rec = book.issue(key)
    assert.equal(rec.agentConvId, out[0].convId)
    assert.equal(rec.orchestrator, out[0].orchestrator)
    assert.ok(rec.orchestrator, "编排会话 id 要写进账本")
    assert.equal(book.session(out[0].agent).parent, rec.orchestrator)
    assert.equal(book.session(out[0].agent).kind, "worker", "工作会话要标成 worker，不能算编排会话")
    assert.equal(dws.calls.openNew.length, 2, "1 条编排 + 1 条工作会话")
    assert.deepEqual(workerOf(book, key).convId, out[0].convId)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("再派一次同一张单：steer 同一条工作会话，不新开第二条", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-redispatch-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const wt = path.join(cfg.worktreeDir, repo.name, "fix-issue-7")
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: .\n")

    const issue = { number: 7, title: "镜像页", body: "", labels: [], assignees: [], url: "" }
    const dws = mkDws()
    const ctx = {
      cfg,
      book: new Book(cfg.stateFile),
      dws,
      log: () => {},
      once: true,
      dryRun: false,
      gitea: {
        listIssues: async () => [issue],
        viewIssue: async (r, n) => ({ ...issue, number: n }),
        commentIssue: async () => ({}),
        editLabels: async () => ({}),
      },
    }

    const first = await runRound(ctx)
    const openedAfterFirst = dws.calls.openNew.length
    // 第二轮：同一张单（账本把 state 放回 reset，模拟失败后重派）
    new Book(cfg.stateFile).setIssue("yyzl/demo#7", { state: "reset", lastFailure: "单测没过" })
    cfg.pickup.excludeLabels = []
    const second = await runRound({ ...ctx, book: new Book(cfg.stateFile) })
    assert.equal(dws.calls.openNew.length, openedAfterFirst, "重派不该新开工作会话")
    assert.equal(dws.calls.steer.length, 1, "要用 steer 接着跑")
    assert.equal(dws.calls.steer[0].target, first[0].convId)
    assert.match(dws.calls.steer[0].text, /单测没过/)
    assert.equal(second[0].resumed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("resume：在同一条工作会话里 steer 续跑，绝不新开", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-resume-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#7", {
      state: "failed",
      agent: "foreman-demo-7",
      agentConvId: "conv-worker-1",
      orchestrator: "conv-orch",
      title: "镜像页",
      lastFailure: "单测没过",
      attempts: 1,
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-7", worktree: "/w/demo/fix-issue-7" }],
    })
    const dws = mkDws()
    const out = await resumeWorker({ cfg, dws, log: () => {} }, { issueKey: "yyzl/demo#7" })
    assert.equal(out.ok, true)
    assert.equal(dws.calls.openNew.length, 0, "resume 不许开新会话")
    assert.equal(dws.calls.steer.length, 1)
    assert.equal(dws.calls.steer[0].target, "conv-worker-1")
    assert.match(dws.calls.steer[0].text, /单测没过/)
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#7").state, "working")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("失败续跑提示：blocked/failed 都指向 resume（不是新开会话）", () => {
  const blocked = nextStepLine({ issueKey: "yyzl/demo#7", result: { status: "failed" } })
  assert.match(blocked, /foreman resume --issue yyzl\/demo#7/)
  assert.match(blocked, /不要新开工作会话/)
  const done = nextStepLine({
    issueKey: "yyzl/demo#7",
    result: { status: "done", prs: [{ repo: "yyzl/demo", pr: 12 }] },
  })
  assert.match(done, /foreman pr merge 12 --repo yyzl\/demo/)
  assert.match(done, /foreman clean --issue yyzl\/demo#7/)
})

test("pollOnce：工作会话收工 → 结论 steer 进编排会话，不新建会话", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-poll-"))
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setOrchestrator({ convId: "conv-orch", name: "foreman-编排" })
    book.record("foreman-编排", { convId: "conv-orch", kind: "orchestrator", notify: false })
    book.setIssue("demo/demo#1", { state: "working", agent: "foreman-demo-1", agentConvId: "conv-a", orchestrator: "conv-orch" })
    book.setWatch({ target: "conv-a", name: "foreman-demo-1", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "" })

    const steered = []
    const notified = []
    const ctx = {
      cfg,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      dws: {
        runningMap: async () => ({ "conv-a": { running: false, title: "foreman-demo-1" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({ lastReply: '<RESULT>{"status":"done","summary":"改完了","pr":12,"tests":"npm test 通过"}</RESULT>' }),
        steer: async (target, text) => { steered.push({ target, text }) },
        notify: async (target, text) => { notified.push({ target, text }) },
      },
    }

    const r = await pollOnce(ctx)
    assert.equal(r.steered, 1)
    assert.equal(r.notified, 0, "会话中心不再通知、不新建会话")
    assert.equal(notified.length, 0)
    assert.equal(steered.length, 1)
    assert.equal(steered[0].target, "conv-orch")
    assert.match(steered[0].text, /工作会话更新/)
    assert.match(steered[0].text, /foreman pr merge 12 --repo demo\/demo/)
    assert.match(new Book(cfg.stateFile).notified["conv-a"].fingerprint, /^[0-9a-f]{12}$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pollOnce：没有编排会话时只落痕（降级不报错）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-noorch-"))
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-a", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "" })
    const ctx = {
      cfg,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      dws: {
        runningMap: async () => ({ "conv-a": { running: false } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T" }),
        info: async () => ({ lastReply: '<RESULT>{"status":"done","summary":"改完了"}</RESULT>' }),
        steer: async () => { throw new Error("没有编排会话不该 steer") },
      },
    }
    const r = await pollOnce(ctx)
    assert.equal(r.steered, 0)
    assert.equal(r.notified, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("steerOrchestrator：账本留痕；没有编排会话直接回 no-orchestrator", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-steer-"))
  try {
    const cfg = mkCfg(dir)
    const dws = mkDws()
    const miss = await steerOrchestrator({ cfg, dws, log: () => {} }, "hi")
    assert.equal(miss.ok, false)
    assert.equal(miss.reason, "no-orchestrator")

    const book = new Book(cfg.stateFile)
    book.setOrchestrator({ convId: "conv-orch", name: "编排" })
    const hit = await steerOrchestrator({ cfg, dws, log: () => {} }, "工作会话更新", { kind: "done" })
    assert.equal(hit.ok, true)
    assert.equal(dws.calls.steer[0].target, "conv-orch")
    assert.equal(new Book(cfg.stateFile).steers["conv-orch"].at(-1).kind, "done")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean：合并关单后归档工作会话、摘监听、清账本会话字段（幂等）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#7", {
      state: "pr-open",
      repo: "yyzl/demo",
      agent: "foreman-demo-7",
      agentConvId: "conv-worker-1",
      orchestrator: "conv-orch",
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-7", worktree: path.join(dir, "gone") }],
    })
    book.record("foreman-demo-7", { convId: "conv-worker-1", issue: 7, notify: true })
    book.setWatch({ target: "conv-worker-1", name: "foreman-demo-7", issueKey: "yyzl/demo#7", repo: "yyzl/demo", number: 7 })

    const dws = mkDws()
    const out = await cleanIssue({ cfg, dws, log: () => {} }, { issueKey: "yyzl/demo#7" })
    assert.equal(out.ok, true)
    assert.ok(out.notes.some((n) => /worktree 已不在/.test(n)))
    assert.deepEqual(dws.calls.archive, ["conv-worker-1"])
    const after = new Book(cfg.stateFile)
    assert.equal(after.issue("yyzl/demo#7").agentConvId, "")
    assert.equal(after.issue("yyzl/demo#7").state, "done")
    assert.equal(after.watch.some((w) => w.target === "conv-worker-1"), false, "监听要摘掉")
    assert.equal(after.session("foreman-demo-7"), null)

    // 幂等：第二次没有可归档的，也不报错
    const again = await cleanIssue({ cfg, dws, log: () => {} }, { issueKey: "yyzl/demo#7" })
    assert.equal(again.ok, true)
    assert.equal(dws.calls.archive.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("dry-run + hand：只打印会交给谁，不 ensure、不 steer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-dry-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    cfg.pickup.handToOrchestrator = true
    const issue = { number: 7, title: "镜像页", body: "", labels: [], assignees: [], url: "" }
    const dws = mkDws()
    const ctx = {
      cfg,
      book: new Book(cfg.stateFile),
      dws,
      log: () => {},
      dryRun: true,
      once: true,
      gitea: { listIssues: async () => [issue] },
    }
    const out = await runRound(ctx)
    assert.equal(out[0].state, "planned")
    assert.equal(out[0].hand, true)
    assert.equal(dws.calls.openNew.length, 0, "dry-run 不许开会话")
    assert.equal(dws.calls.steer.length, 0, "dry-run 不许 steer")
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#7"), null, "dry-run 不许写账本")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("用户自主发起：dispatch 绑调用方会话，不再起全局编排会话", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-caller-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const wt = path.join(cfg.worktreeDir, repo.name, "fix-issue-7")
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: .\n")

    const issue = { number: 7, title: "镜像页", body: "", labels: [], assignees: [], url: "" }
    const dws = mkDws()
    const ctx = {
      cfg,
      book: new Book(cfg.stateFile),
      dws,
      log: () => {},
      once: true,
      dryRun: false,
      // 发起方会话就是这个对话（CLI 从 MCP_VM_CONVERSATION_ID 取到）。
      orchestrator: "conv-user",
      gitea: {
        listIssues: async () => [issue],
        viewIssue: async (r, n) => ({ ...issue, number: n }),
        commentIssue: async () => ({}),
        editLabels: async () => ({}),
      },
    }

    const out = await runRound(ctx)
    assert.equal(out[0].state, "dispatched")
    const key = "yyzl/demo#7"
    const book = new Book(cfg.stateFile)
    const rec = book.issue(key)
    assert.equal(rec.orchestrator, "conv-user", "单上绑的是发起方会话")
    assert.equal(book.session(rec.agent).parent, "conv-user")
    assert.equal(dws.calls.openNew.length, 1, "只开工作会话，不再另起全局编排")
    assert.equal(orchestratorTarget(book), "", "全局编排会话不该被创建")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("用户自主发起 hand：直接交给调用方会话（不开全局编排）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-hand-caller-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const dws = mkDws()
    const issue = { number: 7, title: "镜像页", body: "改 demo 的镜像页" }
    const ctx = { cfg, dws, log: () => {}, gitea: { viewIssue: async () => issue } }

    const out = await handToOrchestrator(ctx, { repoCfg: repo, issue, orchestrator: "conv-user" })
    assert.equal(out.convId, "conv-user")
    assert.equal(dws.calls.openNew.length, 0, "调用方自己就是编排，不用再起会话")
    assert.equal(dws.calls.steer[0].target, "conv-user")
    const rec = new Book(cfg.stateFile).issue("yyzl/demo#7")
    assert.equal(rec.state, "handed")
    assert.equal(rec.orchestrator, "conv-user")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pollOnce：更新 steer 到单上绑的发起方会话，不是全局编排", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-poll-caller-"))
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setOrchestrator({ convId: "conv-orch", name: "foreman-编排" })
    book.setIssue("demo/demo#1", {
      state: "working",
      agent: "foreman-demo-1",
      agentConvId: "conv-a",
      orchestrator: "conv-user",
    })
    book.setWatch({ target: "conv-a", name: "foreman-demo-1", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "" })

    const steered = []
    const ctx = {
      cfg,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      dws: {
        runningMap: async () => ({ "conv-a": { running: false, title: "foreman-demo-1" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({ lastReply: '<RESULT>{"status":"blocked","summary":"要改另一个仓库"}</RESULT>' }),
        steer: async (target, text) => { steered.push({ target, text }) },
        notify: async () => {},
      },
    }

    const r = await pollOnce(ctx)
    assert.equal(r.steered, 1)
    assert.equal(steered[0].target, "conv-user", "发起方会话才是这条单的编排")
    assert.match(steered[0].text, /foreman resume --issue demo\/demo#1/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("sessionFlow 开关：只有显式 enabled=true 才走编排会话", () => {
  assert.equal(sessionFlowEnabled({ sessionFlow: { enabled: true } }), true)
  assert.equal(sessionFlowEnabled({}), false)
  assert.equal(sessionFlowEnabled({ sessionFlow: { enabled: false } }), false)
})
