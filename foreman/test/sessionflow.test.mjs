// 以编排会话为中心：全程只有一条编排会话，工作会话绑在它身上；
// 更新用 steer 插进编排会话，失败也在同一条工作会话里续跑；合并关单后 clean。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Book } from "../src/book.mjs"
import { InboxStore, AgentWorker } from "../src/core/inbox.mjs"
import { deliverTaskUpdate } from "../src/taskevents.mjs"
import { runRound } from "../src/orchestrator.mjs"
import {
  cleanIssue,
  cleanableIssues,
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
    const ctx = { cfg, session: dws, log: () => {} }
    const first = await ensureOrchestrator(ctx)
    assert.equal(first.created, true)
    assert.equal(dws.calls.openNew.length, 1)
    assert.match(dws.calls.openNew[0].name, /编排/)
    assert.match(dws.calls.openNew[0].prompt, /内部 sub agent/)
    assert.match(dws.calls.openNew[0].prompt, /主智能体：创建工单、分配任务/)
    assert.match(dws.calls.openNew[0].prompt, /技能调用时机/)
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

test("hand：编排职责与工单合进首句一次发出，不 steer，账本记 handed（不建工作区）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-hand-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const dws = mkDws()
    const issue = { number: 7, title: "镜像页", body: "改 demo 的镜像页" }
    const ctx = { cfg, session: dws, log: () => {}, gitea: { viewIssue: async () => issue } }

    const out = await handToOrchestrator(ctx, { repoCfg: repo, issue })
    assert.equal(out.state, "handed")
    assert.ok(out.convId)
    assert.equal(dws.calls.openNew.length, 1)
    assert.equal(dws.calls.openNew[0].repo, repo.dir, "编排会话真实 cwd 跟工单仓库走（repos[].dir）")
    assert.equal(dws.calls.steer.length, 0, "hand 不再单独 steer 工单")
    assert.match(dws.calls.openNew[0].prompt, /绑定工单：yyzl\/demo#7/)
    assert.match(dws.calls.openNew[0].prompt, /工单键：yyzl\/demo#7/)
    assert.match(dws.calls.openNew[0].prompt, /改 demo 的镜像页/)
    assert.match(dws.calls.openNew[0].prompt, /内部编码 sub agent/)
    assert.match(dws.calls.openNew[0].prompt, /内部对抗审查 sub agent/)
    assert.match(dws.calls.openNew[0].prompt, /最终验收与合并由人类\/独立验收系统完成/)
    assert.doesNotMatch(dws.calls.openNew[0].prompt, /foreman dispatch --issue|foreman resume <执行会话id>|task\.update Inbox|是否 foreman pr open|核对 PR 后 foreman pr merge/)
    assert.ok(!dws.calls.openNew[0].prompt.includes("resume --issue"), "首句不能教编排按工单号续跑")

    const rec = new Book(cfg.stateFile).issue("yyzl/demo#7")
    assert.equal(rec.state, "handed")
    assert.equal(rec.orchestrator, out.convId)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("hand：仓库没配 dir 映射时 openNew 的 repo 给空串（兜底交给 zcode 驱动的无项目目录）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-hand-norepo-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [] // 仓库不在映射里（如 GitHub 仓或未登记的产品仓）
    const dws = mkDws()
    const issue = { number: 1, title: "t", body: "b" }
    const ctx = { cfg, session: dws, log: () => {}, gitea: { viewIssue: async () => issue } }
    const repoCfg = { repo: "zzz/unmapped", name: "unmapped", base: "main" }
    await handToOrchestrator(ctx, { repoCfg, issue })
    assert.equal(dws.calls.openNew.length, 1)
    assert.equal(dws.calls.openNew[0].repo, "", "不映射就不带 repo，别把 foreman 进程 cwd 泄漏给会话")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("自动巡检：每张工单各建独立编排并绑定，重复交同一张单不重复开", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-per-issue-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const dws = mkDws()
    const ctx = {
      cfg,
      session: dws,
      log: () => {},
      gitea: { viewIssue: async (_repo, n) => ({ number: n, title: `工单 ${n}`, body: `处理 ${n}` }) },
    }

    const first = await handToOrchestrator(ctx, { repoCfg: repo, issue: { number: 7, title: "工单 7" } })
    const second = await handToOrchestrator(ctx, { repoCfg: repo, issue: { number: 8, title: "工单 8" } })
    const again = await handToOrchestrator(ctx, { repoCfg: repo, issue: { number: 7, title: "工单 7" } })
    const book = new Book(cfg.stateFile)

    assert.notEqual(first.convId, second.convId, "不同工单不能共用编排会话")
    assert.equal(again.convId, first.convId, "同一工单要复用已绑定的编排会话")
    assert.equal(dws.calls.openNew.length, 2, "两张工单只各开一条编排")
    assert.match(dws.calls.openNew[0].name, /demo-7-编排/)
    assert.match(dws.calls.openNew[1].name, /demo-8-编排/)
    assert.match(dws.calls.openNew[0].prompt, /绑定工单：yyzl\/demo#7/)
    assert.equal(book.issue("yyzl/demo#7").orchestrator, first.convId)
    assert.equal(book.issue("yyzl/demo#8").orchestrator, second.convId)
    assert.equal(book.session(dws.calls.openNew[0].name).issueKey, "yyzl/demo#7")
    assert.equal(orchestratorTarget(book), "", "自动流程不再创建全局编排")
    assert.equal(dws.calls.steer.length, 0, "重复 hand 也不再 steer，首句已包含工单")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("fresh hand：router agent显式要求时才重开独立编排，普通 hand 仍复用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-fresh-hand-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const dws = mkDws()
    const issue = { number: 7, title: "失联编排", body: "核对后重新分配" }
    const ctx = { cfg, session: dws, log: () => {}, gitea: { viewIssue: async () => issue } }

    const first = await handToOrchestrator(ctx, { repoCfg: repo, issue })
    const reused = await handToOrchestrator(ctx, { repoCfg: repo, issue })
    const fresh = await handToOrchestrator(ctx, { repoCfg: repo, issue, fresh: true })

    assert.equal(reused.convId, first.convId)
    assert.notEqual(fresh.convId, first.convId)
    assert.equal(dws.calls.openNew.length, 2)
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#7").orchestrator, fresh.convId)
    assert.match(dws.calls.openNew[1].prompt, /改派原因|重新分配|接手工单/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("resume：只按工作会话 id 定位并 steer 续跑，绝不新开", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-resume-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    fs.writeFileSync(path.join(repo.dir, "AGENTS.md"), "# 续跑也要携带的原工程约定\n")
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
    book.markIdle("conv-worker-1")
    const out = await resumeWorker({ cfg, session: dws, log: () => {} }, { sessionId: "conv-worker-1" })
    assert.equal(out.ok, true)
    assert.equal(dws.calls.openNew.length, 0, "resume 不许开新会话")
    assert.equal(dws.calls.steer.length, 1)
    assert.equal(dws.calls.steer[0].target, "conv-worker-1")
    assert.match(dws.calls.steer[0].text, /单测没过/)
    assert.match(dws.calls.steer[0].text, /原工程 AGENTS\.md[\s\S]*# 续跑也要携带的原工程约定/)
    assert.equal(new Book(cfg.stateFile).notified["conv-worker-1"].idle, false, "resume 必须唤醒监听，允许读取下一次 RESULT")
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#7").state, "working")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("旧外部会话失败处理提示保持 resume 兼容，并明确与内部 sub agent 隔离", () => {
  const blocked = nextStepLine({ issueKey: "yyzl/demo#7", result: { status: "failed" }, sessionId: "conv-worker-1" })
  assert.match(blocked, /旧外部工作会话事件/)
  assert.match(blocked, /foreman resume conv-worker-1/)
  assert.match(blocked, /需要其他智能体协作/)
  assert.match(blocked, /dws msg --mode steer conv-worker-1/)
  const none = nextStepLine({ issueKey: "yyzl/demo#7", result: { status: "none" }, sessionId: "conv-worker-1" })
  assert.match(none, /没有 RESULT 不代表执行失败/)
  assert.match(none, /根据上面的最后对话判断实际进展/)
  assert.match(none, /foreman resume conv-worker-1/)
  const done = nextStepLine({
    issueKey: "yyzl/demo#7",
    result: { status: "done", prs: [{ repo: "yyzl/demo", pr: 12 }] },
  })
  assert.match(done, /对抗审查/)
  assert.match(done, /发邮件通知验收/)
  assert.match(done, /人类\/独立验收系统/)
  assert.match(done, /foreman clean --issue yyzl\/demo#7/)
  assert.doesNotMatch(done, /foreman pr merge/)
})

test("pollOnce：工作会话最终回复经 Inbox/Worker queue 给所属编排", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-poll-"))
  let inbox
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setOrchestrator({ convId: "conv-orch", name: "foreman-编排" })
    book.record("foreman-编排", { convId: "conv-orch", kind: "orchestrator", notify: false })
    book.setIssue("demo/demo#1", { state: "working", agent: "foreman-demo-1", agentConvId: "conv-a", orchestrator: "conv-orch" })
    book.setWatch({ target: "conv-a", name: "foreman-demo-1", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "" })

    const queued = []
    inbox = new InboxStore(new DatabaseSync(path.join(dir, "console.db")))
    const ctx = {
      cfg, book, inbox,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      session: {
        runningMap: async () => ({ "conv-a": { running: false, title: "foreman-demo-1" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({ lastReply: "改完了，已提交，npm test 通过。" }),
        queue: async (target, text) => { queued.push({ target, text }) },
      },
    }
    const worker = new AgentWorker({ store: inbox, retryMs: 0, handlers: { "task.update": async (batch) => {
      for (const event of batch) await deliverTaskUpdate(ctx, event)
    } } })

    const r = await pollOnce(ctx)
    assert.equal(r.steered, 0)
    assert.equal(r.notified, 0)
    assert.equal(queued.length, 0, "poll 只入箱，不直接投递")
    await worker.runOnce()
    assert.equal(queued.length, 1)
    assert.equal(queued[0].target, "conv-orch")
    assert.match(queued[0].text, /工作会话状态变化/)
    assert.match(queued[0].text, /改完了，已提交，npm test 通过。/)
    assert.doesNotMatch(queued[0].text, /自动开 PR|foreman pr merge/)
    assert.match(new Book(cfg.stateFile).notified["conv-a"].fingerprint, /^[0-9a-f]{12}$/)
  } finally {
    inbox.close?.()
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
      session: {
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
    const miss = await steerOrchestrator({ cfg, session: dws, log: () => {} }, "hi")
    assert.equal(miss.ok, false)
    assert.equal(miss.reason, "no-orchestrator")

    const book = new Book(cfg.stateFile)
    book.setOrchestrator({ convId: "conv-orch", name: "编排" })
    const hit = await steerOrchestrator({ cfg, session: dws, log: () => {} }, "工作会话更新", { kind: "done" })
    assert.equal(hit.ok, true)
    assert.equal(dws.calls.steer[0].target, "conv-orch")
    assert.equal(new Book(cfg.stateFile).steers["conv-orch"].at(-1).kind, "done")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean --local：PR 未全合也能单独清本地（不关单、账本不动）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-local-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    const gone = path.join(dir, "wt-9")
    book.setIssue("yyzl/demo#9", {
      state: "pr-open",
      repo: "yyzl/demo",
      prs: [{ repo: "yyzl/demo", pr: 9, branch: "fix/issue-9" }],
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-9", worktree: gone }],
    })
    const remoteCalls = []
    const ctx = {
      cfg,
      session: mkDws(),
      log: () => {},
      gitea: { closeIssue: async (r, n) => { remoteCalls.push(`${r}#${n}`) } },
    }
    const out = await cleanIssue(ctx, { issueKey: "yyzl/demo#9", remote: false, local: true })
    assert.equal(out.ok, true)
    assert.deepEqual(out.scope, { remote: false, local: true })
    assert.deepEqual(remoteCalls, [], "--local 不碰远端")
    assert.equal(out.notes.some((n) => /worktree 已不在/.test(n)), true, "本地工作区照常清")
    const after = new Book(cfg.stateFile).issue("yyzl/demo#9")
    assert.equal(after.state, "pr-open", "账本状态不动（还没关单）")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean --remote：PR 全合并时只关单摘标签，不删工作区", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-remote-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    const wt10 = path.join(dir, "wt-10")
    fs.mkdirSync(wt10, { recursive: true })
    fs.writeFileSync(path.join(wt10, ".git"), "gitdir: .\n")
    book.setIssue("yyzl/demo#10", {
      state: "pr-open",
      repo: "yyzl/demo",
      prs: [{ repo: "yyzl/demo", pr: 10, branch: "fix/issue-10" }],
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-10", worktree: wt10 }],
    })
    book.markPrSeen("yyzl/demo#10", { repo: "yyzl/demo", pr: 10, merged: true })
    book.markMergeAsked("yyzl/demo#10", { pr: 10, status: "merged" })
    const ctx = {
      cfg,
      session: mkDws(),
      log: () => {},
      gitea: { closeIssue: async () => {}, editLabels: async () => ({ changed: true }) },
    }
    const out = await cleanIssue(ctx, { issueKey: "yyzl/demo#10", remote: true, local: false })
    assert.equal(out.ok, true)
    assert.deepEqual(out.scope, { remote: true, local: false })
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#10").state, "done")
    assert.ok(fs.existsSync(path.join(dir, "wt-10")), "--remote 不动本地工作区")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean 拆分：pr-open 且 PR 全合并 → clean 关单（closeIssue + 摘标签 + done）再清尾", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-close-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#8", {
      state: "pr-open",
      repo: "yyzl/demo",
      prs: [{ repo: "yyzl/demo", pr: 8, branch: "fix/issue-8" }],
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-8", worktree: path.join(dir, "wt-8") }],
    })
    // pr-open 节点盖 merged（prSeen.merged）+ mergeAsk
    book.markPrSeen("yyzl/demo#8", { repo: "yyzl/demo", pr: 8, merged: true })
    book.markMergeAsked("yyzl/demo#8", { pr: 8, status: "merged" })

    const remoteClosed = []
    const labels = []
    const ctx = {
      cfg,
      session: mkDws(),
      log: () => {},
      gitea: {
        closeIssue: async (repo, n) => { remoteClosed.push(`${repo}#${n}`) },
        editLabels: async (repo, n, opts) => { labels.push({ repo, n, opts }); return { changed: true } },
      },
    }
    const out = await cleanIssue(ctx, { issueKey: "yyzl/demo#8" })
    assert.equal(out.ok, true)
    assert.ok(out.notes.some((n) => /已关单/.test(n)))
    assert.deepEqual(remoteClosed, ["yyzl/demo#8"])
    assert.deepEqual(labels.map((l) => l.opts), [{ remove: "ready-for-agent" }])
    const after = new Book(cfg.stateFile).issue("yyzl/demo#8")
    assert.equal(after.state, "done")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean 拆分：PR 没合完 → 拒绝清理（先去 pr merge）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-open-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#9", {
      state: "pr-open",
      repo: "yyzl/demo",
      prs: [{ repo: "yyzl/demo", pr: 9, branch: "fix/issue-9" }],
    })
    const ctx = { cfg, session: mkDws(), log: () => {}, gitea: { closeIssue: async () => { throw new Error("不应关单") } } }
    const out = await cleanIssue(ctx, { issueKey: "yyzl/demo#9" })
    assert.equal(out.ok, false)
    assert.equal(out.reason, "pr-not-merged")
    assert.match(out.notes[0], /先合并再 clean/)
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#9").state, "pr-open", "账本不动")
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
      state: "done",
      repo: "yyzl/demo",
      agent: "foreman-demo-7",
      agentConvId: "conv-worker-1",
      orchestrator: "conv-orch",
      workspaces: [{ repo: "yyzl/demo", branch: "fix/issue-7", worktree: path.join(dir, "gone") }],
    })
    book.record("foreman-demo-7", { convId: "conv-worker-1", issue: 7, notify: true })
    // 这张单自己的编排会话（foreman 建的）：收口后没人再用，clean 要一并归档。
    book.record("foreman-demo-7-编排", { convId: "conv-orch", kind: "orchestrator", role: "orchestrator", issueKey: "yyzl/demo#7", issue: 7 })
    book.setWatch({ target: "conv-worker-1", name: "foreman-demo-7", issueKey: "yyzl/demo#7", repo: "yyzl/demo", number: 7 })

    const dws = mkDws()
    const out = await cleanIssue({ cfg, session: dws, log: () => {} }, { issueKey: "yyzl/demo#7" })
    assert.equal(out.ok, true)
    assert.ok(out.notes.some((n) => /worktree 已不在/.test(n)))
    assert.ok(out.notes.some((n) => /编排会话已归档/.test(n)), "编排会话要一起归档")
    assert.deepEqual(dws.calls.archive, ["conv-worker-1", "conv-orch"])
    const after = new Book(cfg.stateFile)
    assert.equal(after.issue("yyzl/demo#7").agentConvId, "")
    assert.equal(after.issue("yyzl/demo#7").orchestrator, "", "归档后编排绑定要清掉")
    assert.equal(after.issue("yyzl/demo#7").state, "done")
    assert.equal(after.watch.some((w) => w.target === "conv-worker-1"), false, "监听要摘掉")
    assert.equal(after.session("foreman-demo-7"), null)
    assert.equal(after.session("foreman-demo-7-编排"), null, "编排会话记录也要摘掉")

    // 幂等：第二次没有可归档的，也不报错
    const again = await cleanIssue({ cfg, session: dws, log: () => {} }, { issueKey: "yyzl/demo#7" })
    assert.equal(again.ok, true)
    assert.equal(dws.calls.archive.length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean：编排会话是调用方自己的会话时不归档（只留一条说明）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-caller-"))
  try {
    const cfg = mkCfg(dir)
    cfg.repos = [mkRepo(dir, "demo")]
    const book = new Book(cfg.stateFile)
    // 用户在自己的会话里发起，那条会话被绑成这张单的编排：账本里没有 orchestrator 记录。
    book.setIssue("yyzl/demo#9", {
      state: "done",
      repo: "yyzl/demo",
      agent: "",
      agentConvId: "",
      orchestrator: "conv-user-9",
    })
    const dws = mkDws()
    const out = await cleanIssue({ cfg, session: dws, log: () => {} }, { issueKey: "yyzl/demo#9" })
    assert.equal(out.ok, true)
    assert.deepEqual(dws.calls.archive, [], "用户自己的会话绝不能被归档")
    const after = new Book(cfg.stateFile)
    assert.equal(after.issue("yyzl/demo#9").orchestrator, "conv-user-9", "绑定留着，别把用户会话的线索抹掉")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean：这条单只剩下自己的编排会话时，仍算可清（clean --all 能扫到）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-all-"))
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#11", { state: "done", repo: "yyzl/demo", agent: "", agentConvId: "" })
    book.record("foreman-demo-11-编排", { convId: "conv-orch-11", kind: "orchestrator", issueKey: "yyzl/demo#11", issue: 11 })
    book.setIssue("yyzl/demo#12", { state: "done", repo: "yyzl/demo", agent: "", agentConvId: "" })
    book.setIssue("yyzl/demo#13", { state: "pr-open", repo: "yyzl/demo", agent: "foreman-demo-13", agentConvId: "conv-w-13" })

    assert.deepEqual(cleanableIssues(new Book(cfg.stateFile)), ["yyzl/demo#11"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("clean：currentConv 就是编排会话本身时不归档（dws 不允许归档命令发起方）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-clean-self-"))
  try {
    const cfg = mkCfg(dir)
    const book = new Book(cfg.stateFile)
    book.setIssue("yyzl/demo#15", {
      state: "done",
      repo: "yyzl/demo",
      orchestrator: "conv-self",
      agent: "",
      agentConvId: "",
    })
    book.record("foreman-demo-15-编排", { convId: "conv-self", kind: "orchestrator", issueKey: "yyzl/demo#15", issue: 15 })

    const dws = mkDws()
    const out = await cleanIssue({ cfg, session: dws, log: () => {} }, { issueKey: "yyzl/demo#15", currentConv: "conv-self" })
    assert.deepEqual(dws.calls.archive, [], "自己不能归档自己")
    assert.ok(out.notes.some((n) => /就是当前会话/.test(n)))
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#15").orchestrator, "conv-self", "留给服务下一轮收")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("dry-run + run：只打印会投 router，不开会话、不写账本", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-dry-"))
  try {
    const cfg = mkCfg(dir)
    const repo = mkRepo(dir, "demo")
    cfg.repos = [repo]
    const issue = { number: 7, title: "镜像页", body: "", labels: [], assignees: [], url: "" }
    const dws = mkDws()
    const ctx = {
      cfg,
      book: new Book(cfg.stateFile),
      session: dws,
      log: () => {},
      dryRun: true,
      once: true,
      gitea: { listIssues: async () => [issue] },
      routeIssue: async () => { throw new Error("dry-run 不许 routeIssue") },
    }
    const out = await runRound(ctx)
    assert.equal(out[0].state, "planned")
    assert.equal(out[0].routed, "router")
    assert.equal(dws.calls.openNew.length, 0, "dry-run 不许开会话")
    assert.equal(dws.calls.steer.length, 0, "dry-run 不许 steer")
    assert.equal(new Book(cfg.stateFile).issue("yyzl/demo#7"), null, "dry-run 不许写账本")
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
    const ctx = { cfg, session: dws, log: () => {}, gitea: { viewIssue: async () => issue } }

    const out = await handToOrchestrator(ctx, { repoCfg: repo, issue, orchestrator: "conv-user" })
    assert.equal(out.convId, "conv-user")
    assert.equal(dws.calls.openNew.length, 0, "调用方自己就是编排，不用再起会话")
    assert.equal(dws.calls.steer.length, 0, "调用方已持有工单上下文，不再 steer")
    const rec = new Book(cfg.stateFile).issue("yyzl/demo#7")
    assert.equal(rec.state, "handed")
    assert.equal(rec.orchestrator, "conv-user")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pollOnce：任务事件 queue 到工单绑定的发起方，而不是全局编排", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-flow-poll-caller-"))
  let inbox
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

    const queued = []
    inbox = new InboxStore(new DatabaseSync(path.join(dir, "console.db")))
    const ctx = {
      cfg, book, inbox,
      state: { polling: false, watchers: new Map(), dwsErrors: 0, notifiedCount: 0 },
      log: () => {},
      gitea: {},
      session: {
        runningMap: async () => ({ "conv-a": { running: false, title: "foreman-demo-1" } }),
        status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
        info: async () => ({ lastReply: "还需要修改另一个仓库，当前工作区无法完成。" }),
        queue: async (target, text) => { queued.push({ target, text }) },
      },
    }
    const worker = new AgentWorker({ store: inbox, retryMs: 0, handlers: { "task.update": async (batch) => {
      for (const event of batch) await deliverTaskUpdate(ctx, event)
    } } })

    const r = await pollOnce(ctx)
    assert.equal(r.steered, 0)
    await worker.runOnce()
    assert.equal(queued.length, 1)
    assert.equal(queued[0].target, "conv-user", "发起方会话才是这条单的编排")
    assert.match(queued[0].text, /还需要修改另一个仓库/)
    assert.doesNotMatch(queued[0].text, /foreman resume conv-a/, "Worker 不自动补业务下一步")
  } finally {
    inbox.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("sessionFlow 开关：只有显式 enabled=true 才走编排会话", () => {
  assert.equal(sessionFlowEnabled({ sessionFlow: { enabled: true } }), true)
  assert.equal(sessionFlowEnabled({}), false)
  assert.equal(sessionFlowEnabled({ sessionFlow: { enabled: false } }), false)
})
