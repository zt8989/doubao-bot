import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { inspectorOnce } from "../src/inspector.mjs"
import { handleRequest, startServer } from "../src/service.mjs"
import { DwsDriver } from "../src/dwsdrv.mjs"

function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-inspector-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    inspector: { intervalSeconds: 600, recreateAfterHours: 24 },
    ...over,
  }
  const opened = []
  const queued = []
  const dws = {
    async openNew(args) {
      opened.push(args)
      return { convId: `inspector-${opened.length}` }
    },
    async queue(target, text) {
      queued.push({ target, text })
      return { ok: true }
    },
  }
  const state = { inspector: { running: false, count: 0 } }
  return { dir, cfg, dws, state, opened, queued }
}

test("检查智能体底层投递使用 dws msg --mode queue", async () => {
  const driver = new DwsDriver()
  let call = null
  driver.json = async (args) => {
    const file = args[args.indexOf("--file") + 1]
    call = { args, text: fs.readFileSync(file, "utf8") }
    return { ok: true }
  }
  await driver.queue("inspector-1", "本轮飞行检查")
  assert.equal(call.args[0], "msg")
  assert.equal(call.args[1], "inspector-1")
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
  await assert.rejects(driver.steer("inspector-1", "继续"), /未知命令/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "msg")
})

test("检查智能体首轮新建，后续巡检复用同一条会话", async () => {
  const f = fixture()
  try {
    const book = new Book(f.cfg.stateFile)
    book.setIssue("yyzl/demo#1", { state: "working", agentConvId: "worker-1", orchestrator: "orch-1" })
    book.setIssue("yyzl/demo#2", { state: "done", worktree: "/tmp/merged-worktree", agentConvId: "worker-2" })
    book.setIssue("yyzl/demo#3", { state: "pr-open", worktree: "/tmp/open-pr-worktree", agentConvId: "worker-3" })
    book.setIssue("yyzl/demo#4", { state: "handed", orchestrator: "orch-4" })

    const first = await inspectorOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    const second = await inspectorOnce(f, { now: new Date("2026-11-19T00:10:00Z") })

    assert.equal(first.action, "created")
    assert.equal(second.action, "queued")
    assert.equal(f.opened.length, 1)
    assert.equal(f.queued.length, 1)
    assert.equal(f.queued[0].target, "inspector-1")
    assert.match(f.opened[0].prompt, /只能修正 Foreman 本地账本/)
    assert.match(f.opened[0].prompt, /foreman tasks --json/)
    assert.match(f.opened[0].prompt, /全部在飞工单合计最多/)
    assert.match(f.opened[0].prompt, /dry-run 只用于确认候选优先级/)
    assert.match(f.opened[0].prompt, /handed.*占/)
    assert.match(f.queued[0].text, /在飞容量：3\/2；还可新接：0/)
    assert.match(f.queued[0].text, /dry-run 只用于确认候选优先级/)
    assert.match(f.queued[0].text, /yyzl\/demo#4/)
    assert.match(f.queued[0].text, /foreman tasks --json/)
    assert.match(f.queued[0].text, /foreman clean --all/)
    assert.match(f.queued[0].text, /已收口待清理快照：yyzl\/demo#2\n/)
    assert.match(f.queued[0].text, /yyzl\/demo#1/)
    assert.match(f.queued[0].text, /worker-1/)

    const saved = new Book(f.cfg.stateFile)
    assert.equal(saved.data.inspector.convId, "inspector-1")
    assert.equal(saved.data.inspector.sendCount, 2)
    assert.equal(saved.data.inspector.lastSentAt, "2026-11-19T00:10:00.000Z")
    assert.equal(saved.session(f.opened[0].name).kind, "inspector")
    assert.equal(saved.session(f.opened[0].name).notify, false)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("PR 候选通知复用同一检查会话并 queue，不夹带主动巡检", async () => {
  const f = fixture()
  try {
    await inspectorOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    const out = await inspectorOnce(f, {
      now: new Date("2026-11-19T00:05:00Z"),
      force: true,
      notice: "【Foreman · 他人 PR 待分配】\nforeman pr assign 72 --repo demo/demo",
    })
    assert.equal(out.action, "queued")
    assert.equal(out.convId, "inspector-1")
    assert.equal(f.queued.length, 1)
    assert.match(f.queued[0].text, /pr assign 72/)
    assert.doesNotMatch(f.queued[0].text, /10分钟巡检|每轮先执行/)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("从未成功投递的会话也从首次失败计满24小时才轮换", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-inspector-never-ok-"))
  const stateFile = path.join(dir, "state.json")
  const b = new Book(stateFile)
  b.data.inspector = { convId: "inspect-never-ok" }
  b.save()
  let clock = new Date("2026-11-18T00:00:00.000Z").getTime()
  const opens = []
  const queues = []
  const dws = {
    openNew: async (opts) => { opens.push(opts); return { convId: "inspect-replacement" } },
    queue: async (conv, text) => { queues.push(conv); throw new Error("窗口忙") },
  }
  const cfg = { stateFile, inspector: { enabled: true, intervalSeconds: 600, recreateAfterHours: 24 }, pickup: { maxRunning: 2 } }
  await inspectorOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  clock += 10 * 60 * 1000
  await inspectorOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  assert.deepEqual(opens, [], "首次失败后才10分钟，不得新建")
  assert.deepEqual(queues, ["inspect-never-ok", "inspect-never-ok"])
  clock = new Date("2026-11-19T00:01:00.000Z").getTime()
  const out = await inspectorOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  assert.equal(out.ok, true)
  assert.equal(out.action, "created")
  assert.equal(out.reason, "stale-24h")
  assert.equal(opens.length, 1)
  assert.equal(new Book(stateFile).data.inspector.convId, "inspect-replacement")
  assert.equal(new Book(stateFile).data.inspector.failingSince, "")
})

test("投递失败不刷新成功时间，满24小时才重建检查会话", async () => {
  const f = fixture()
  try {
    await inspectorOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    f.dws.queue = async () => { throw new Error("app_unavailable") }

    const failed = await inspectorOnce(f, { now: new Date("2026-11-19T00:10:00Z") })
    assert.equal(failed.ok, false)
    assert.equal(new Book(f.cfg.stateFile).data.inspector.lastSentAt, "2026-11-19T00:00:00.000Z")

    const early = await inspectorOnce(f, { now: new Date("2026-11-19T23:59:59Z") })
    assert.equal(early.ok, false)
    assert.equal(f.opened.length, 1)

    f.dws.queue = async () => ({ ok: true })
    const rotated = await inspectorOnce(f, { now: new Date("2026-11-20T00:00:00Z") })
    assert.equal(rotated.action, "created")
    assert.equal(rotated.reason, "stale-24h")
    assert.equal(f.opened.length, 2)
    assert.equal(new Book(f.cfg.stateFile).data.inspector.convId, "inspector-2")
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("inspect RPC：立即写入检查智能体 Inbox", async () => {
  const f = fixture()
  try {
    let calls = 0
    const ctx = {
      cfg: f.cfg,
      state: f.state,
      inspector: async () => { calls++; return { ok: true, action: "inbox", convId: "inspector-rpc" } },
    }
    const out = await handleRequest(ctx, { id: "test", cmd: "inspect" })
    assert.equal(out.ok, true)
    assert.equal(out.convId, "inspector-rpc")
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("服务 Schedule 只写 Inbox，Worker 消费后才唤醒检查会话", async () => {
  const f = fixture()
  Object.assign(f.cfg, {
    inspector: { enabled: true, intervalSeconds: 600, recreateAfterHours: 24 },
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
  try {
    server = await startServer({ cfg: f.cfg, dws: f.dws, log() {} })
    assert.equal(f.opened.length, 0, "Schedule 同步时不得直接调用 Agent")
    assert.equal(f.queued.length, 0)
    server.schedules.tick(new Date())
    await server.worker.idle()
    assert.equal(f.opened.length, 1, "Worker 消费后才创建检查会话")
    assert.equal(server.inbox.counts().done, 1)
  } finally {
    if (server) await server.close()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
