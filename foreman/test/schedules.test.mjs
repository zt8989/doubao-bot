// 定时任务开关：状态视图、内存改值、SQLite 持久化，以及控制台的两个接口。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { listSchedules, applySchedules, nextWorkdayStart, cronOf, hydrateSchedules, scheduleDefinitions, saveScheduleSettings } from "../src/core/schedules.mjs"
import { InboxStore, ScheduleRunner } from "../src/core/inbox.mjs"
import { SCHEDULE_SCRIPT_DIR } from "../src/core/executors.mjs"
import { validateCron, nextCronTime } from "../src/core/cron.mjs"
import { inWorkHours } from "../src/util.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"

const baseCfg = () => ({
  pickup: { auto: true, me: "233151", labelIds: [5], intervalSeconds: 1800, maxPerRound: 1 },
  prWatch: { enabled: true, intervalSeconds: 300 },
  router: { enabled: true, intervalSeconds: 60, recreateAfterHours: 24 },
  workHours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30", offUntil: "" },
})

function sqliteSchedules() {
  const store = new InboxStore(new DatabaseSync(":memory:"))
  return {
    store,
    save(cfg) {
      new ScheduleRunner({ store }).sync(scheduleDefinitions(cfg))
      saveScheduleSettings(store, cfg)
    },
  }
}

test("listSchedules：我的工单扫描与执行会话轮询都是持久脚本任务", () => {
  const cfg = baseCfg()
  const rows = listSchedules(cfg)
  assert.deepEqual(rows.map((r) => r.id), ["pickup", "prWatch", "mail", "router", "dreaming", "workHours"])
  const pickup = rows.find((r) => r.id === "pickup")
  assert.equal(pickup.enabled, true)
  assert.equal(pickup.cron, "*/30 * * * *")
  assert.equal(pickup.executor, "script")
  assert.deepEqual(pickup.script, { path: `${SCHEDULE_SCRIPT_DIR}/pickup.mjs`, exportName: "pickupPollOnce", args: {} })
  assert.match(pickup.detail, /指派给 233151/)
  assert.match(pickup.detail, /ready-for-agent/)
  assert.match(pickup.detail, /router agent/)
  const dreaming = rows.find((r) => r.id === "dreaming")
  assert.equal(dreaming.enabled, true)
  assert.equal(dreaming.cron, "0 3 * * *")
  assert.equal(dreaming.executor, "agent")
  assert.equal(dreaming.runLabel, "立即整理")
  assert.match(dreaming.detail, /前一日|每日记忆/)
  const router = rows.find((r) => r.id === "router")
  assert.equal(router.enabled, true)
  assert.equal(router.cron, "* * * * *")
  assert.equal(router.runLabel, "立即轮询")
  assert.equal(router.executor, "script")
  assert.deepEqual(router.script, { path: `${SCHEDULE_SCRIPT_DIR}/router.mjs`, exportName: "pollOnce", args: {} })
  assert.equal(router.agent, undefined)
  assert.match(router.detail, /代码轮询/)
  assert.match(router.detail, /不定时调用 Agent/)
  assert.match(router.detail, /不自动接单/)
  assert.equal(rows.find((r) => r.id === "prWatch").enabled, true)
  assert.equal(rows.find((r) => r.id === "prWatch").executor, "script")
  assert.deepEqual(rows.find((r) => r.id === "prWatch").script, { path: `${SCHEDULE_SCRIPT_DIR}/prwatch.mjs`, exportName: "prPollOnce", args: {} })
  assert.equal(rows.find((r) => r.id === "prWatch").cron, "*/5 * * * *")
  // 验收邮件默认关（testers 还是占位符），cron 用 mail.pollSeconds。
  const mailRow = rows.find((r) => r.id === "mail")
  assert.equal(mailRow.enabled, false)
  assert.equal(mailRow.cron, "*/5 * * * *")
  assert.match(mailRow.detail, /[FM-…]/)
  assert.deepEqual(mailRow.script, { path: `${SCHEDULE_SCRIPT_DIR}/mail.mjs`, exportName: "mailPollOnce", args: {} })
  assert.equal(rows.some((r) => ["merge", "planner"].includes(r.id)), false)
  assert.deepEqual(rows.filter((r) => r.runnable).map((r) => r.id), ["pickup", "prWatch", "mail", "router", "dreaming"])
  assert.equal(rows.find((r) => r.id === "workHours").runnable, false)
  assert.equal(mailRow.runLabel, "立即收信")
  const inside = applySchedules(cfg, {})
  assert.equal(inside.find((r) => r.id === "workHours").enabled, true)
})

test("cron：校验表达式、计算下一次，配置优先于 intervalSeconds", () => {
  assert.equal(validateCron("*/15 8-17 * * 1-5").ok, true)
  assert.equal(validateCron("0 9 * * 1,3,5").ok, true)
  assert.equal(validateCron("bad").ok, false)
  const next = nextCronTime("*/15 * * * *", new Date(2026, 10, 12, 10, 1, 0))
  assert.equal(next.getHours(), 10)
  assert.equal(next.getMinutes(), 15)
  const cfg = baseCfg()
  assert.equal(cronOf(cfg, "router"), "* * * * *")
  assert.equal(cronOf({ router: { cron: "0 9 * * 1-5", intervalSeconds: 600 } }, "router"), "0 9 * * 1-5")
})

test("applySchedules：router 代码轮询可改 cron 与开关，非法 cron 不落内存", () => {
  const cfg = baseCfg()
  const rows = applySchedules(cfg, { router: { cron: "*/15 8-17 * * 1-5" } })
  assert.equal(cfg.router.cron, "*/15 8-17 * * 1-5")
  assert.equal(cfg.router.enabled, true, "只改时间不应顺手关闭")
  assert.equal(rows.find((r) => r.id === "router").cron, "*/15 8-17 * * 1-5")
  applySchedules(cfg, { prWatch: { enabled: false, cron: "0 */2 * * *" } })
  assert.equal(cfg.prWatch.enabled, false)
  assert.equal(cfg.prWatch.cron, "0 */2 * * *")
  assert.throws(() => applySchedules(cfg, { router: { cron: "bad" } }), /cron 不合法/)
  assert.equal(cfg.router.cron, "*/15 8-17 * * 1-5")
  assert.throws(() => applySchedules(cfg, { workHours: { cron: "* * * * *" } }), /没有 cron/)
})

test("applySchedules：PR 与代码轮询的脚本路径、参数可编辑并持久化到 SQLite", () => {
  const { store, save } = sqliteSchedules()
  const cfg = baseCfg()
  const rows = applySchedules(cfg, {
    prWatch: {
      enabled: true,
      cron: "*/7 * * * *",
      script: { path: "scripts/pr-watch.mjs", exportName: "scan", args: { limit: 5, labels: ["ready"] } },
    },
    router: { script: { path: "scripts/watch.mjs", exportName: "poll", args: { batch: 10 } } },
  })
  assert.deepEqual(rows.find((row) => row.id === "prWatch").script, {
    path: "scripts/pr-watch.mjs",
    exportName: "scan",
    args: { limit: 5, labels: ["ready"] },
  })
  assert.deepEqual(rows.find((row) => row.id === "router").script, {
    path: "scripts/watch.mjs",
    exportName: "poll",
    args: { batch: 10 },
  })

  save(cfg)
  const persisted = Object.fromEntries(store.schedules().map((row) => [row.id, row]))
  assert.deepEqual(persisted.prWatch.payload.script, {
    path: "scripts/pr-watch.mjs",
    exportName: "scan",
    args: { limit: 5, labels: ["ready"] },
  })
  assert.equal(persisted.prWatch.cron, "*/7 * * * *")
  assert.deepEqual(persisted.router.payload.script, { path: "scripts/watch.mjs", exportName: "poll", args: { batch: 10 } })
  assert.equal(cfg.router.recreateAfterHours, 24, "非调度配置仍留在原配置对象")

  assert.throws(() => applySchedules(cfg, { prWatch: { script: { args: [] } } }), /JSON 对象/)
  assert.throws(() => applySchedules(cfg, { mail: { script: { path: " " } } }), /脚本路径不能为空/)
  assert.throws(() => applySchedules(cfg, { router: { agent: { prompt: "不应再配置定时 Agent" } } }), /不是 Agent 执行器/)
  assert.throws(() => applySchedules(cfg, { workHours: { script: { path: "x", exportName: "y", args: {} } } }), /不是脚本执行器/)
  assert.throws(() => applySchedules(cfg, { prWatch: { agent: { prompt: "x" } } }), /不是 Agent 执行器/)
})

test("applySchedules：pickup 使用 auto 开关，prWatch / router 独立翻转", () => {
  const cfg = baseCfg()
  const rows = applySchedules(cfg, { pickup: { enabled: false, cron: "*/5 * * * *" }, prWatch: false, router: false })
  assert.equal(cfg.pickup.auto, false)
  assert.equal(cfg.pickup.cron, "*/5 * * * *")
  assert.equal(rows.find((r) => r.id === "pickup").enabled, false)
  assert.equal(rows.find((r) => r.id === "pickup").cron, "*/5 * * * *")
  assert.equal(cfg.prWatch.enabled, false)
  assert.equal(cfg.router.enabled, false)
  assert.equal(rows.find((r) => r.id === "router").enabled, false)
  assert.equal(rows.find((r) => r.id === "prWatch").enabled, false)
})

test("applySchedules：dreaming 的开关与 cron 写入 SQLite，保留其他记忆配置", () => {
  const { store, save } = sqliteSchedules()
  const cfg = { ...baseCfg(), memory: { dir: "custom-memory", maxEntryChars: 200, dreaming: { enabled: true, cron: "0 3 * * *" } } }
  const rows = applySchedules(cfg, { dreaming: { enabled: false, cron: "0 4 * * *" } })
  assert.equal(rows.find((row) => row.id === "dreaming").enabled, false)
  assert.equal(rows.find((row) => row.id === "dreaming").cron, "0 4 * * *")
  save(cfg)
  const persisted = store.schedules().find((row) => row.id === "dreaming")
  assert.equal(persisted.enabled, false)
  assert.equal(persisted.cron, "0 4 * * *")
  assert.equal(cfg.memory.dir, "custom-memory")
  assert.equal(cfg.memory.maxEntryChars, 200)
  assert.throws(() => applySchedules(cfg, { dreaming: { agent: { prompt: "绕过门禁" } } }), /不是 Agent 执行器/)
})

test("applySchedules：workHours 的开关是临时闭嘴，恢复后清空 offUntil", () => {
  const cfg = baseCfg()
  applySchedules(cfg, { workHours: false })
  assert.match(cfg.workHours.offUntil, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/)
  assert.ok(new Date(cfg.workHours.offUntil).getTime() > Date.now())
  assert.equal(inWorkHours(cfg), false, "闭嘴期间窗口判断要是 false")
  const paused = listSchedules(cfg).find((r) => r.id === "workHours")
  assert.equal(paused.enabled, false)
  assert.equal(paused.offUntil, cfg.workHours.offUntil)

  applySchedules(cfg, { workHours: true })
  assert.equal(cfg.workHours.offUntil, "")
  assert.equal(listSchedules(cfg).find((r) => r.id === "workHours").enabled, true)
})

test("工作时间：工作日与开始结束时间可编辑、校验并持久化到 SQLite", () => {
  const { store, save } = sqliteSchedules()
  const cfg = baseCfg()
  applySchedules(cfg, { workHours: { days: [1, 2, 3, 4, 5, 6], start: "07:45", end: "20:30" } })
  assert.equal(cfg.workHours.start, "07:45")
  assert.equal(cfg.workHours.end, "20:30")
  assert.deepEqual(cfg.workHours.days, [1, 2, 3, 4, 5, 6])
  save(cfg)
  assert.deepEqual(store.scheduleSetting("workHours"), {
    enabled: true,
    days: [1, 2, 3, 4, 5, 6],
    start: "07:45",
    end: "20:30",
    offUntil: "",
  })
  assert.equal(cfg.pickup.me, "233151")
  assert.throws(() => applySchedules(cfg, { workHours: { start: "25:00", end: "20:30" } }), /有效的 HH:mm/)
  assert.throws(() => applySchedules(cfg, { workHours: { start: "20:30", end: "08:30" } }), /早于结束时间/)
  assert.throws(() => applySchedules(cfg, { workHours: { days: [] } }), /至少选择一天/)
  assert.throws(() => applySchedules(cfg, { workHours: { days: [0, 1] } }), /星期/)
  assert.equal(cfg.workHours.start, "07:45", "非法时间不能污染内存配置")
  assert.deepEqual(cfg.workHours.days, [1, 2, 3, 4, 5, 6], "非法工作日不能污染内存配置")
})

test("nextWorkdayStart：跳过周末，落在工作时段起点", () => {
  // 2026-11-13 是周五 19:00（窗口之后），下一个开始应是周一 08:30
  const at = new Date(2026, 10, 13, 19, 0, 0)
  const next = nextWorkdayStart(baseCfg(), at)
  const day = next.getDay() === 0 ? 7 : next.getDay()
  assert.equal(day, 1, "应跳到周一")
  assert.equal(next.getHours(), 8)
  assert.equal(next.getMinutes(), 30)
})

test("SQLite：重启后开关、cron、脚本与工作时间都以数据库为准", () => {
  const { store, save } = sqliteSchedules()
  const cfg = baseCfg()
  applySchedules(cfg, {
    pickup: false,
    router: {
      enabled: false,
      cron: "*/15 8-17 * * 1-5",
      script: { path: "scripts/poll.mjs", exportName: "run", args: { limit: 6 } },
    },
    workHours: { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "20:30" },
  })
  save(cfg)

  // 模拟重启时旧 config.json 仍留着一组完全不同的值。
  const restarted = {
    ...baseCfg(),
    mail: { enabled: true, pollSeconds: 300 },
    memory: { dreaming: { enabled: false, cron: "0 5 * * *" } },
  }
  restarted.router.cron = "* * * * *"
  restarted.workHours.start = "09:00"
  restarted.workHours.end = "18:00"
  hydrateSchedules(restarted, store)

  assert.equal(restarted.pickup.auto, false)
  assert.equal(restarted.router.enabled, false)
  assert.equal(restarted.router.cron, "*/15 8-17 * * 1-5")
  assert.deepEqual(restarted.router.script, { path: "scripts/poll.mjs", exportName: "run", args: { limit: 6 } })
  assert.equal(restarted.mail.enabled, false)
  assert.equal(restarted.memory.dreaming.enabled, true)
  assert.equal(restarted.memory.dreaming.cron, "0 3 * * *")
  assert.deepEqual(restarted.workHours.days, [1, 2, 3, 4, 5, 6])
  assert.equal(restarted.workHours.start, "08:00")
  assert.equal(restarted.workHours.end, "20:30")
})

test("SQLite：首次升级时已有任务行优先，旧配置只补缺失的脚本定义", () => {
  const { store, save } = sqliteSchedules()
  new ScheduleRunner({ store }).sync([{ id: "router", kind: "router", cron: "*/9 * * * *", enabled: false }])
  const cfg = baseCfg()
  cfg.router.script = { path: "scripts/legacy.mjs", exportName: "poll", args: { from: "config" } }
  hydrateSchedules(cfg, store)
  assert.equal(cfg.router.enabled, false)
  assert.equal(cfg.router.cron, "*/9 * * * *")
  assert.deepEqual(cfg.router.script, { path: "scripts/legacy.mjs", exportName: "poll", args: { from: "config" } })
  save(cfg)

  const restarted = baseCfg()
  restarted.router.script = { path: "scripts/changed.mjs", exportName: "other", args: {} }
  hydrateSchedules(restarted, store)
  assert.deepEqual(restarted.router.script, { path: "scripts/legacy.mjs", exportName: "poll", args: { from: "config" } })
})

test("HTTP：/api/schedules 读写开关，/api/pickup 立刻跑一轮", async () => {
  const cfg = baseCfg()
  const calls = { pickup: 0, patches: [] }
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-http-"))
  const ctx = {
    schedules: () => listSchedules(cfg),
    workHours: () => ({ days: cfg.workHours.days, start: cfg.workHours.start, end: cfg.workHours.end }),
    applySchedules: (patch) => {
      calls.patches.push(patch)
      return applySchedules(cfg, patch)
    },
    pickup: async () => {
      calls.pickup++
      return { ok: true, dispatched: 0 }
    },
    prPoll: async () => ({ ok: true }),
  }
  const h = await startConsoleHttp({ store: {}, ctx, dir, host: "127.0.0.1", port: 0, log: () => {} })
  const base = h.url
  try {
    const list = await (await fetch(`${base}/api/schedules`)).json()
    assert.equal(list.ok, true)
    assert.equal(list.schedules.find((s) => s.id === "router").enabled, true)
    assert.deepEqual(list.workHours, { days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30" })

    const set = await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { router: false } }),
      })
    ).json()
    assert.equal(set.ok, true)
    assert.equal(set.schedules.find((s) => s.id === "router").enabled, false)
    assert.deepEqual(calls.patches, [{ router: false }])

    const hours = await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { workHours: { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "20:30" } } }),
      })
    ).json()
    assert.equal(hours.ok, true)
    assert.deepEqual(hours.workHours, { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "20:30" })
    assert.equal(hours.schedules.find((s) => s.id === "workHours").detail.includes("08:00–20:30"), true)

    const configured = await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { prWatch: { script: { path: "scripts/pr.mjs", exportName: "scan", args: { limit: 2 } } } } }),
      })
    ).json()
    assert.equal(configured.ok, true)
    assert.deepEqual(configured.schedules.find((s) => s.id === "prWatch").script, { path: "scripts/pr.mjs", exportName: "scan", args: { limit: 2 } })

    const polling = await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { router: { script: { path: "scripts/poll.mjs", exportName: "run", args: { limit: 6 } } } } }),
      })
    ).json()
    assert.equal(polling.ok, true)
    assert.deepEqual(polling.schedules.find((s) => s.id === "router").script, { path: "scripts/poll.mjs", exportName: "run", args: { limit: 6 } })

    const invalid = await fetch(`${base}/api/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { workHours: { start: "21:00", end: "08:00" } } }),
    })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).message, /早于结束时间/)

    const run = await (await fetch(`${base}/api/pickup`, { method: "POST" })).json()
    assert.equal(run.ok, true)
    assert.equal(calls.pickup, 1)
  } finally {
    await new Promise((r) => h.server.close(r))
  }
})

test("HTTP：/api/schedules/run 按 id 立刻执行一项，缺 id 或不可执行都要拒", async () => {
  const cfg = baseCfg()
  const ran = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-http-run-"))
  const ctx = {
    schedules: () => listSchedules(cfg),
    applySchedules: (patch) => applySchedules(cfg, patch),
    runSchedule: async (id) => {
      ran.push(id)
      return { ok: true, skipped: null, id }
    },
  }
  const h = await startConsoleHttp({ store: {}, ctx, dir, host: "127.0.0.1", port: 0, log: () => {} })
  const base = h.url
  const post = (body) =>
    fetch(`${base}/api/schedules/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  try {
    const ok = await (await post({ id: "prWatch" })).json()
    assert.equal(ok.ok, true)
    assert.deepEqual(ran, ["prWatch"])

    const noId = await post({})
    assert.equal(noId.status, 400)
    assert.equal((await noId.json()).error, "missing_id")

    // 服务侧的 runSchedule 只认能跑的三项，别的不该落成 500。
    ctx.runSchedule = async () => {
      throw Object.assign(new Error("workHours 没有可以立即执行的动作"), { code: "schedule_not_runnable" })
    }
    const bad = await post({ id: "workHours" })
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error, "schedule_not_runnable")
  } finally {
    await new Promise((r) => h.server.close(r))
  }
})
