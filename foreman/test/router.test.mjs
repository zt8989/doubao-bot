import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { routerOnce } from "../src/core/router.mjs"
import { handleRequest, startServer } from "../src/service.mjs"
import { DwsDriver } from "../src/dwsdrv.mjs"

function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-router-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    agent: "dws",
    router: { intervalSeconds: 600, recreateAfterHours: 24 },
    ...over,
  }
  const opened = []
  const queued = []
  const dws = {
    async openNew(args) {
      opened.push(args)
      return { convId: `router-${opened.length}` }
    },
    async queue(target, text) {
      queued.push({ target, text })
      return { ok: true }
    },
  }
  const state = { router: { running: false, count: 0 } }
  return { dir, cfg, dws, state, opened, queued }
}

test("router agent底层投递使用 dws msg --mode queue", async () => {
  const driver = new DwsDriver()
  let call = null
  driver.json = async (args) => {
    const file = args[args.indexOf("--file") + 1]
    call = { args, text: fs.readFileSync(file, "utf8") }
    return { ok: true }
  }
  await driver.queue("router-1", "本轮飞行检查")
  assert.equal(call.args[0], "msg")
  assert.equal(call.args[1], "router-1")
  assert.deepEqual(call.args.slice(-2), ["--mode", "queue"])
  assert.equal(call.text, "本轮飞行检查")
})

test("Foreman 不再回退调用已删除的 dws steer 命令", async () => {
  const driver = new DwsDriver()
  const calls = []
  driver.json = async (args) => {
    calls.push(args)
    if (args[0] === "msg") throw new Error("dws msg 失败：未知命令")
    return { ok: true }
  }
  await assert.rejects(driver.steer("router-1", "继续"), /未知命令/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "msg")
})

test("router agent首轮新建，后续巡检复用同一条会话", async () => {
  const f = fixture()
  try {
    const book = new Book(f.cfg.stateFile)
    book.setIssue("yyzl/demo#1", { state: "working", agentConvId: "worker-1", orchestrator: "orch-1" })
    book.setIssue("yyzl/demo#2", { state: "done", worktree: "/tmp/merged-worktree", agentConvId: "worker-2" })
    book.setIssue("yyzl/demo#3", { state: "pr-open", worktree: "/tmp/open-pr-worktree", agentConvId: "worker-3" })
    book.setIssue("yyzl/demo#4", { state: "handed", orchestrator: "orch-4" })

    const first = await routerOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    const second = await routerOnce(f, { now: new Date("2026-11-19T00:10:00Z") })

    assert.equal(first.action, "created")
    assert.equal(second.action, "queued")
    assert.equal(f.opened.length, 1)
    assert.equal(f.queued.length, 1)
    assert.equal(f.queued[0].target, "router-1")
    assert.match(f.opened[0].prompt, /## 职责/)
    assert.match(f.opened[0].prompt, /## 技能调用时机/)
    // 子智能体分配协议：首句必须带上两个岗位提示词文件的绝对路径与 CreateSession 分配方式
    assert.match(f.opened[0].prompt, /## 子智能体分配协议/)
    assert.match(f.opened[0].prompt, /CreateSession/)
    assert.match(f.opened[0].prompt, /编码智能体提示词文件：.*agents[/\\]coder\.md/)
    assert.match(f.opened[0].prompt, /审查智能体提示词文件：.*agents[/\\]reviewer\.md/)
    assert.match(f.opened[0].prompt, /没有 project\/工作目录参数/)
    assert.match(f.opened[0].prompt, /WaitSessions/)
    assert.match(f.opened[0].prompt, /SendToSession/)
    assert.match(f.opened[0].prompt, /修正本地账本/)
    assert.match(f.opened[0].prompt, /foreman tasks --json/)
    assert.match(f.opened[0].prompt, /真实运行/)
    assert.match(f.opened[0].prompt, /PR 待验收\/合并/)
    assert.match(f.opened[0].prompt, /已收口仅指 issueState=done\/cleaned/)
    assert.match(f.opened[0].prompt, /cleaned\/keys 是候选数，不是实际清理数/)
    assert.match(f.opened[0].prompt, /终态清理检查完成，未误清理非终态任务/)
    assert.doesNotMatch(f.opened[0].prompt, /代码每 5 分钟|代码定时器|代码 Schedule/)
    assert.match(f.queued[0].text, /foreman tasks --json/)
    assert.match(f.queued[0].text, /实时结果/)
    assert.match(f.queued[0].text, /在飞 X\/2/)
    assert.match(f.queued[0].text, /真实运行 N 个/)
    assert.match(f.queued[0].text, /sessions 树/)
    assert.match(f.queued[0].text, /summary\.unresolvedIssues/)
    assert.match(f.queued[0].text, /state=running/)
    assert.match(f.queued[0].text, /done\/cleaned/)
    assert.match(f.queued[0].text, /cleaned\/keys.*不是实际清理数/)
    assert.match(f.queued[0].text, /dry-run 仅看候选优先级/)
    assert.match(f.queued[0].text, /满额禁止 run\/pickup\/hand\/orch start\/dispatch/)
    assert.ok(f.queued[0].text.length < 1000, "周期消息不得膨胀成长清单")
    assert.doesNotMatch(f.queued[0].text, /已收口待清理快照|未收口工单快照/)
    assert.doesNotMatch(f.queued[0].text, /yyzl\/demo#|worker-1|orch-1/)
    assert.doesNotMatch(f.queued[0].text, /在飞容量：|还可新接/)

    const saved = new Book(f.cfg.stateFile)
    assert.equal(saved.data.router.convId, "router-1")
    assert.equal(saved.data.router.sendCount, 2)
    assert.equal(saved.data.router.lastSentAt, "2026-11-19T00:10:00.000Z")
    assert.equal(saved.session(f.opened[0].name).kind, "router")
    assert.equal(saved.session(f.opened[0].name).notify, false)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("每次新建 router agent 都注入 MEMORY.md 与 USER.md，复用会话不重复注入", async () => {
  const f = fixture()
  try {
    const dir = path.join(f.dir, "memory")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- 旧部署约定 <!-- key:deploy; observed:2026-11-18; status:active -->\n")
    fs.writeFileSync(path.join(dir, "USER.md"), "- 始终简短回复 <!-- key:style; observed:2026-11-18; status:active -->\n")

    await routerOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    await routerOnce(f, { now: new Date("2026-11-19T00:10:00Z") })
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- 新部署约定 <!-- key:deploy; observed:2026-11-19; status:active -->\n")
    await routerOnce(f, { now: new Date("2026-11-20T00:11:00Z") })

    assert.equal(f.opened.length, 2)
    assert.match(f.opened[0].prompt, /### MEMORY\.md[\s\S]*旧部署约定/)
    assert.match(f.opened[0].prompt, /### USER\.md[\s\S]*始终简短回复/)
    assert.match(f.opened[0].prompt, /foreman memory set/)
    assert.match(f.opened[0].prompt, /foreman memory note/)
    assert.match(f.opened[0].prompt, /foreman memory search/)
    assert.match(f.opened[0].prompt, /不要直接.*(?:写入|编辑|覆盖)|禁止直接.*(?:写入|编辑|覆盖)/)
    assert.match(f.opened[1].prompt, /新部署约定/)
    assert.doesNotMatch(f.opened[1].prompt, /旧部署约定/)
    assert.doesNotMatch(f.queued[0].text, /旧部署约定|始终简短回复|### MEMORY\.md/)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("PR 候选通知复用同一路由会话并 queue，不夹带主动巡检", async () => {
  const f = fixture()
  try {
    await routerOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    const out = await routerOnce(f, {
      now: new Date("2026-11-19T00:05:00Z"),
      force: true,
      notice: "【Foreman · 他人 PR 待分配】\nforeman pr assign 72 --repo demo/demo",
    })
    assert.equal(out.action, "queued")
    assert.equal(out.convId, "router-1")
    assert.equal(f.queued.length, 1)
    assert.match(f.queued[0].text, /pr assign 72/)
    assert.doesNotMatch(f.queued[0].text, /10分钟巡检|每轮先执行/)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("从未成功投递的会话也从首次失败计满24小时才轮换", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-router-never-ok-"))
  const stateFile = path.join(dir, "state.json")
  const b = new Book(stateFile)
  b.data.router = { convId: "inspect-never-ok" }
  b.save()
  let clock = new Date("2026-11-18T00:00:00.000Z").getTime()
  const opens = []
  const queues = []
  const dws = {
    openNew: async (opts) => { opens.push(opts); return { convId: "inspect-replacement" } },
    queue: async (conv, text) => { queues.push(conv); throw new Error("窗口忙") },
  }
  const cfg = { stateFile, router: { enabled: true, intervalSeconds: 600, recreateAfterHours: 24 }, pickup: { maxRunning: 2 } }
  await routerOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  clock += 10 * 60 * 1000
  await routerOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  assert.deepEqual(opens, [], "首次失败后才10分钟，不得新建")
  assert.deepEqual(queues, ["inspect-never-ok", "inspect-never-ok"])
  clock = new Date("2026-11-19T00:01:00.000Z").getTime()
  const out = await routerOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  assert.equal(out.ok, true)
  assert.equal(out.action, "created")
  assert.equal(out.reason, "stale-24h")
  assert.equal(opens.length, 1)
  assert.equal(new Book(stateFile).data.router.convId, "inspect-replacement")
  assert.equal(new Book(stateFile).data.router.failingSince, "")
})

test("投递失败不刷新成功时间，满24小时才重建路由会话", async () => {
  const f = fixture()
  try {
    await routerOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    f.dws.queue = async () => { throw new Error("app_unavailable") }

    const failed = await routerOnce(f, { now: new Date("2026-11-19T00:10:00Z") })
    assert.equal(failed.ok, false)
    assert.equal(new Book(f.cfg.stateFile).data.router.lastSentAt, "2026-11-19T00:00:00.000Z")

    const early = await routerOnce(f, { now: new Date("2026-11-19T23:59:59Z") })
    assert.equal(early.ok, false)
    assert.equal(f.opened.length, 1)

    f.dws.queue = async () => ({ ok: true })
    const rotated = await routerOnce(f, { now: new Date("2026-11-20T00:00:00Z") })
    assert.equal(rotated.action, "created")
    assert.equal(rotated.reason, "stale-24h")
    assert.equal(f.opened.length, 2)
    assert.equal(new Book(f.cfg.stateFile).data.router.convId, "router-2")
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("inspect RPC：直接调用 router agent 并返回执行结果", async () => {
  const f = fixture()
  try {
    let calls = 0
    const ctx = {
      cfg: f.cfg,
      state: f.state,
      router: async () => { calls++; return { ok: true, action: "inbox", convId: "router-rpc" } },
    }
    const out = await handleRequest(ctx, { id: "test", cmd: "inspect" })
    assert.equal(out.ok, true)
    assert.equal(out.convId, "router-rpc")
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("服务 Schedule 用代码轮询执行会话，手动 route 仍调用路由 Agent", async () => {
  const f = fixture()
  Object.assign(f.cfg, {
    router: { enabled: true, intervalSeconds: 600, recreateAfterHours: 24 },
    prWatch: { enabled: false },
    mail: { enabled: false },
    workHours: { enabled: false },
    pickup: { maxRunning: 2 },
    inbox: { schedulePollMs: 60000, pollMs: 60000 },
    service: {
      http: { port: 0, portFile: path.join(f.dir, "service.port"), db: path.join(f.dir, "console.db") },
      pidFile: path.join(f.dir, "foreman.pid"),
      logFile: path.join(f.dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    repos: [],
  })
  let server
  let pollCalls = 0
  f.dws.runningMap = async () => {
    pollCalls++
    return {}
  }
  try {
    server = await startServer({ cfg: f.cfg, dws: f.dws, log() {} })
    assert.equal(f.opened.length, 0, "Schedule 同步时不得直接调用 Agent")
    assert.equal(f.queued.length, 0)
    const fired = await server.schedules.tick(new Date())
    assert.equal(f.opened.length, 0, "十分钟 Schedule 不再创建或唤醒路由会话")
    assert.equal(f.queued.length, 0)
    assert.equal(pollCalls, 1, "Schedule 直接运行 pollOnce")
    const routerRun = fired.find((item) => item.scheduleId === "router")
    assert.equal(routerRun?.executor, "script")
    assert.equal(routerRun?.kind, "schedule.noop")
    assert.equal(server.inbox.count(), 0, "没有任务活动时只轮询，不写完成回执")
    assert.equal(server.schedules.store.schedules().find((s) => s.id === "router").payload.executor, "script")

    const manual = await server.router()
    assert.equal(manual.ok, true)
    assert.equal(f.opened.length, 1, "显式 route 仍保留 Agent 通道")
    await server.worker.idle()
    assert.equal(server.inbox.count(), 0)
  } finally {
    if (server) await server.close()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("投递目标不存在时清掉死绑定，下一轮直接新建（不等 24h stale）", async () => {
  const f = fixture()
  try {
    const book = new Book(f.cfg.stateFile)
    book.data.router = {
      convId: "noop-foreman-router-dead-1",
      name: "foreman-router-dead",
      lastSentAt: "2026-11-19T00:05:00.000Z",
    }
    book.save()

    const dead = new Error("zcode 账本里没有会话：noop-foreman-router-dead-1（可能从没派过，或账本被清了）")
    dead.code = "session_missing"
    f.dws.queue = async () => {
      throw dead
    }
    const first = await routerOnce(f, { now: new Date("2026-11-19T00:10:00Z") })
    assert.equal(first.ok, false)
    const afterFail = new Book(f.cfg.stateFile)
    assert.equal(afterFail.data.router.convId, "", "死绑定应被立即清空，不等 recreateAfterHours")
    assert.equal(afterFail.data.router.name, "")

    f.dws.queue = async (target, text) => {
      f.queued.push({ target, text })
      return { ok: true }
    }
    const second = await routerOnce(f, { now: new Date("2026-11-19T00:11:00Z") })
    assert.equal(second.action, "created", "清掉死绑定后下一轮应直接新建")
    assert.equal(f.opened.length, 1)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
