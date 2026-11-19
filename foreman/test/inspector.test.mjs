import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { inspectorOnce } from "../src/inspector.mjs"
import { handleRequest } from "../src/service.mjs"

function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-inspector-"))
  const cfg = {
    stateFile: path.join(dir, "state.json"),
    inspector: { intervalSeconds: 600, recreateAfterHours: 24 },
    ...over,
  }
  const opened = []
  const steered = []
  const dws = {
    async openNew(args) {
      opened.push(args)
      return { convId: `inspector-${opened.length}` }
    },
    async steer(target, text) {
      steered.push({ target, text })
      return { ok: true }
    },
  }
  const state = { inspector: { running: false, count: 0 } }
  return { dir, cfg, dws, state, opened, steered }
}

test("检查智能体首轮新建，后续巡检复用同一条会话", async () => {
  const f = fixture()
  try {
    const book = new Book(f.cfg.stateFile)
    book.setIssue("yyzl/demo#1", { state: "working", agentConvId: "worker-1", orchestrator: "orch-1" })

    const first = await inspectorOnce(f, { now: new Date("2026-11-19T00:00:00Z") })
    const second = await inspectorOnce(f, { now: new Date("2026-11-19T00:10:00Z") })

    assert.equal(first.action, "created")
    assert.equal(second.action, "steered")
    assert.equal(f.opened.length, 1)
    assert.equal(f.steered.length, 1)
    assert.equal(f.steered[0].target, "inspector-1")
    assert.match(f.opened[0].prompt, /只能修正 Foreman 本地账本/)
    assert.match(f.steered[0].text, /yyzl\/demo#1/)
    assert.match(f.steered[0].text, /worker-1/)

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

test("从未成功投递的会话也从首次失败计满24小时才轮换", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-inspector-never-ok-"))
  const stateFile = path.join(dir, "state.json")
  const b = new Book(stateFile)
  b.data.inspector = { convId: "inspect-never-ok" }
  b.save()
  let clock = new Date("2026-11-18T00:00:00.000Z").getTime()
  const opens = []
  const steers = []
  const dws = {
    openNew: async (opts) => { opens.push(opts); return { convId: "inspect-replacement" } },
    steer: async (conv, text) => { steers.push(conv); throw new Error("窗口忙") },
  }
  const cfg = { stateFile, inspector: { enabled: true, intervalSeconds: 600, recreateAfterHours: 24 }, pickup: { maxRunning: 2 } }
  await inspectorOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  clock += 10 * 60 * 1000
  await inspectorOnce({ cfg, dws, log() {} }, { now: new Date(clock) })
  assert.deepEqual(opens, [], "首次失败后才10分钟，不得新建")
  assert.deepEqual(steers, ["inspect-never-ok", "inspect-never-ok"])
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
    f.dws.steer = async () => { throw new Error("app_unavailable") }

    const failed = await inspectorOnce(f, { now: new Date("2026-11-19T00:10:00Z") })
    assert.equal(failed.ok, false)
    assert.equal(new Book(f.cfg.stateFile).data.inspector.lastSentAt, "2026-11-19T00:00:00.000Z")

    const early = await inspectorOnce(f, { now: new Date("2026-11-19T23:59:59Z") })
    assert.equal(early.ok, false)
    assert.equal(f.opened.length, 1)

    f.dws.steer = async () => ({ ok: true })
    const rotated = await inspectorOnce(f, { now: new Date("2026-11-20T00:00:00Z") })
    assert.equal(rotated.action, "created")
    assert.equal(rotated.reason, "stale-24h")
    assert.equal(f.opened.length, 2)
    assert.equal(new Book(f.cfg.stateFile).data.inspector.convId, "inspector-2")
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("inspect RPC：立即投递由服务注入的检查智能体入口", async () => {
  const f = fixture()
  try {
    let calls = 0
    const ctx = {
      cfg: f.cfg,
      state: f.state,
      inspector: async () => { calls++; return { ok: true, action: "steered", convId: "inspector-rpc" } },
    }
    const out = await handleRequest(ctx, { id: "test", cmd: "inspect" })
    assert.equal(out.ok, true)
    assert.equal(out.convId, "inspector-rpc")
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
