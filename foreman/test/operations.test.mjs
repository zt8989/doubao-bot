// 操作日志：running → success/failed、重启中断、查询接口与巡检落账。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConsoleStore } from "../src/console.mjs"
import { startOperation, finishOperation } from "../src/operations.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"
import { pickupOnce } from "../src/service.mjs"

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fm-ops-"))

test("ConsoleStore：操作从进行中收尾，可按状态过滤，重启标记中断", () => {
  const store = new ConsoleStore(path.join(tmpdir(), "console.db"))
  try {
    const a = store.operationStart({ action: "dispatch", title: "派单 yyzl/r#1", key: "yyzl/r#1", detail: "开工作区" })
    const b = store.operationStart({ action: "merge", title: "合并 PR yyzl/r#2", key: "yyzl/r#2" })
    assert.ok(a > 0 && b > a)
    assert.equal(store.operations({ status: "running" }).length, 2)

    store.operationFinish(a, "success", "已派到执行会话")
    store.operationFinish(b, "failed", "有冲突")
    assert.equal(store.operationGet(a).status, "success")
    assert.equal(store.operationGet(a).detail, "已派到执行会话")
    assert.equal(store.operations({ status: "failed" })[0].action, "merge")
    assert.equal(store.operations({ action: "dispatch" }).length, 1)

    const c = store.operationStart({ action: "archive", title: "归档执行会话" })
    store.recoverOperations()
    assert.equal(store.operationGet(c).status, "interrupted")
    assert.equal(store.operations({ status: "running" }).length, 0)
  } finally {
    store.close()
  }
})

test("操作日志 helper：主流程看不到 store 也能跑，写日志不影响返回", () => {
  const store = new ConsoleStore(path.join(tmpdir(), "console.db"))
  const lines = []
  try {
    const ctx = { consoleStore: store, log: (s) => lines.push(s) }
    const id = startOperation(ctx, "deliver", "投递工单结论", { key: "r#1" })
    finishOperation(ctx, id, "success", "已新建编排会话")
    assert.equal(store.operationGet(id).status, "success")
    assert.ok(lines.some((s) => s.includes("投递工单结论")))
    assert.doesNotThrow(() => finishOperation({}, 0, "failed", "不应落库"))
  } finally {
    store.close()
  }
})

test("pickupOnce：巡检与派单操作落库，run 能拿到 consoleStore 记录单张派单", async () => {
  const dir = tmpdir()
  const store = new ConsoleStore(path.join(dir, "console.db"))
  try {
    const ctx = {
      cfg: {
        stateFile: path.join(dir, "state.json"),
        pickup: { auto: true, maxPerRound: 1 },
        workHours: { enabled: false },
        repos: [],
      },
      state: { pickup: { running: false, count: 0 }, watchers: new Map() },
      dws: {},
      log: () => {},
      consoleStore: store,
    }
    let seenStore = null
    const out = await pickupOnce(ctx, {
      run: async (runCtx) => {
        seenStore = runCtx.consoleStore
        const op = startOperation(runCtx, "dispatch", "派单 yyzl/r#8", { key: "yyzl/r#8" })
        finishOperation(runCtx, op, "success", "已派出")
        return [{ repo: "yyzl/r", number: 8, state: "dispatched" }]
      },
    })
    assert.equal(out.dispatched, 1)
    assert.equal(seenStore, store)
    const rows = store.operations()
    assert.equal(rows.find((r) => r.action === "dispatch").status, "success")
    const pickup = rows.find((r) => r.action === "pickup")
    assert.equal(pickup.status, "success")
    assert.match(pickup.detail, /派出 1 条/)
  } finally {
    store.close()
  }
})

test("HTTP：首页进行中数量使用执行会话实时状态", async () => {
  const dir = tmpdir()
  const stateFile = path.join(dir, "state.json")
  const now = new Date().toISOString()
  fs.writeFileSync(stateFile, JSON.stringify({
    issues: {
      "a/b#1": { title: "实际在跑", state: "working", agentConvId: "conv-live", updatedAt: now },
      "a/b#2": { title: "等待收口", state: "working", agentConvId: "conv-idle", updatedAt: now },
    },
  }))
  const store = new ConsoleStore(path.join(dir, "console.db"))
  const ctx = {
    cfg: { stateFile },
    state: { pr: {} },
    dws: { runningMap: async () => ({ "conv-live": { running: true }, "conv-idle": { running: false } }) },
  }
  const h = await startConsoleHttp({ store, ctx, dir, host: "127.0.0.1", port: 0, log: () => {} })
  try {
    const snap = await (await fetch(`${h.url}/api/snapshot`, { cache: "no-store" })).json()
    assert.equal(snap.stats.working, 1)
    assert.deepEqual(snap.tasks.filter((t) => t.running).map((t) => t.key), ["a/b#1"])
  } finally {
    await new Promise((r) => h.server.close(r))
    store.close()
  }
})

test("HTTP：/api/operations 返回进行中与历史操作", async () => {
  const dir = tmpdir()
  const store = new ConsoleStore(path.join(dir, "console.db"))
  const running = store.operationStart({ action: "merge", title: "合并 PR yyzl/r#9", key: "yyzl/r#9" })
  const done = store.operationStart({ action: "dispatch", title: "派单 yyzl/r#8", key: "yyzl/r#8" })
  store.operationFinish(done, "success", "已派出")
  const h = await startConsoleHttp({ store, ctx: {}, dir, host: "127.0.0.1", port: 0, log: () => {} })
  try {
    const all = await (await fetch(`${h.url}/api/operations?limit=10`)).json()
    assert.equal(all.ok, true)
    assert.equal(all.operations.length, 2)
    assert.equal(all.operations.find((r) => r.id === running).status, "running")
    const failedOnly = await (await fetch(`${h.url}/api/operations?status=failed`)).json()
    assert.equal(failedOnly.operations.length, 0)
  } finally {
    await new Promise((r) => h.server.close(r))
    store.close()
  }
})

test("HTTP：/api/inbox 与 /api/outbox 返回首页队列并透传筛选条件", async () => {
  const dir = tmpdir()
  const calls = []
  const h = await startConsoleHttp({
    store: {}, ctx: {}, dir, host: "127.0.0.1", port: 0, log: () => {},
    onRpc: async (req) => {
      calls.push(req)
      if (req.cmd === "inbox list") {
        return { ok: true, events: [{ id: 1, kind: "task.update", status: "pending", payload: {} }], total: 42, schedules: [], counts: { pending: 42 } }
      }
      return { ok: true, messages: [{ id: 2, channel: "mail", status: "sent", payload: { subject: "验收" } }], total: 51, counts: { sent: 51 } }
    },
  })
  try {
    const inbox = await (await fetch(`${h.url}/api/inbox?page=2&pageSize=25&status=pending`)).json()
    assert.equal(inbox.events[0].kind, "task.update")
    assert.equal(inbox.counts.pending, 42)
    assert.equal(inbox.page, 2)
    assert.equal(inbox.pageSize, 25)
    assert.equal(inbox.total, 42)
    assert.equal(inbox.totalPages, 2)
    const outbox = await (await fetch(`${h.url}/api/outbox?page=3&pageSize=50&status=sent&channel=mail`)).json()
    assert.equal(outbox.messages[0].channel, "mail")
    assert.equal(outbox.counts.sent, 51)
    assert.equal(outbox.totalPages, 2)
    assert.deepEqual(calls.map(({ cmd, limit, offset, status, channel }) => ({ cmd, limit, offset, status, channel })), [
      { cmd: "inbox list", limit: 25, offset: 25, status: "pending", channel: undefined },
      { cmd: "outbox list", limit: 50, offset: 100, status: "sent", channel: "mail" },
    ])
    const rejected = await fetch(`${h.url}/api/inbox`, { method: "POST" })
    assert.equal(rejected.status, 405)
  } finally {
    await new Promise((r) => h.server.close(r))
  }
})
