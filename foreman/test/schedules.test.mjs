// 定时任务开关：状态视图、内存改值、写回配置，以及控制台的两个接口。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listSchedules, applySchedules, persistSchedules, nextWorkdayStart, cronOf } from "../src/schedules.mjs"
import { validateCron, nextCronTime } from "../src/cron.mjs"
import { inWorkHours } from "../src/util.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"

const baseCfg = () => ({
  pickup: { auto: false, intervalSeconds: 1800, maxPerRound: 1 },
  prWatch: { enabled: true, intervalSeconds: 300 },
  router: { enabled: true, intervalSeconds: 600, recreateAfterHours: 24 },
  workHours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30", offUntil: "" },
})

test("listSchedules：保留 PR/邮件，router agent取代自动接单与执行收工轮询", () => {
  const cfg = baseCfg()
  const rows = listSchedules(cfg)
  assert.deepEqual(rows.map((r) => r.id), ["prWatch", "mail", "router", "workHours"])
  const router = rows.find((r) => r.id === "router")
  assert.equal(router.enabled, true)
  assert.equal(router.cron, "*/10 * * * *")
  assert.equal(router.runLabel, "立即巡检")
  assert.match(router.detail, /queue 同一路由会话/)
  assert.match(router.detail, /24/)
  assert.equal(rows.find((r) => r.id === "prWatch").enabled, true)
  assert.equal(rows.find((r) => r.id === "prWatch").cron, "*/5 * * * *")
  // 验收邮件默认关（testers 还是占位符），cron 用 mail.pollSeconds。
  const mailRow = rows.find((r) => r.id === "mail")
  assert.equal(mailRow.enabled, false)
  assert.equal(mailRow.cron, "*/5 * * * *")
  assert.match(mailRow.detail, /[FM-…]/)
  assert.equal(rows.some((r) => ["merge", "pickup", "planner"].includes(r.id)), false)
  assert.deepEqual(rows.filter((r) => r.runnable).map((r) => r.id), ["prWatch", "mail", "router"])
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
  assert.equal(cronOf(cfg, "router"), "*/10 * * * *")
  assert.equal(cronOf({ router: { cron: "0 9 * * 1-5", intervalSeconds: 600 } }, "router"), "0 9 * * 1-5")
})

test("applySchedules：router agent可改 cron 与开关，非法 cron 不落内存", () => {
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

test("applySchedules：翻转 prWatch / router，旧 pickup 不再成为定时任务", () => {
  const cfg = baseCfg()
  const rows = applySchedules(cfg, { pickup: true, prWatch: false, router: false })
  assert.equal(cfg.pickup.auto, false, "旧 pickup.auto 不能被控制台重新打开")
  assert.equal(cfg.prWatch.enabled, false)
  assert.equal(cfg.router.enabled, false)
  assert.equal(rows.find((r) => r.id === "router").enabled, false)
  assert.equal(rows.find((r) => r.id === "prWatch").enabled, false)
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

test("工作时间：开始与结束可自由设置、校验并持久化，其他配置保持不变", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-work-hours-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, JSON.stringify({ pickup: { auto: true, me: "233151" }, workHours: { start: "08:30", end: "17:30", days: [1, 2, 3, 4, 5] } }))
  const cfg = baseCfg()
  applySchedules(cfg, { workHours: { start: "07:45", end: "20:30" } })
  assert.equal(cfg.workHours.start, "07:45")
  assert.equal(cfg.workHours.end, "20:30")
  assert.deepEqual(cfg.workHours.days, [1, 2, 3, 4, 5])
  persistSchedules(file, { workHours: { start: "07:45", end: "20:30" } }, cfg)
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.workHours.start, "07:45")
  assert.equal(raw.workHours.end, "20:30")
  assert.equal(raw.pickup.me, "233151")
  assert.throws(() => applySchedules(cfg, { workHours: { start: "25:00", end: "20:30" } }), /有效的 HH:mm/)
  assert.throws(() => applySchedules(cfg, { workHours: { start: "20:30", end: "08:30" } }), /早于结束时间/)
  assert.equal(cfg.workHours.start, "07:45", "非法时间不能污染内存配置")
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

test("persistSchedules：只改开关字段，其余配置原样保留", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-sched-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        repos: [{ repo: "yyzl/win-ai-harness", dir: "~/x", base: "sit-20261126" }],
        pickup: { auto: false, me: "233151", intervalSeconds: 1800 },
        prWatch: { enabled: true, ignoreAuthors: ["233151"] },
        router: { enabled: true, intervalSeconds: 600 },
        workHours: { start: "08:30", end: "17:30", days: [1, 2, 3, 4, 5] },
      },
      null,
      2
    )
  )
  const cfg = baseCfg()
  applySchedules(cfg, { router: false, workHours: false })
  assert.equal(persistSchedules(file, { router: false, workHours: false }, cfg), true)

  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.router.enabled, false)
  assert.equal(raw.router.intervalSeconds, 600)
  assert.equal(raw.pickup.auto, false, "旧自动接单开关不再被调度接口修改")
  assert.equal(raw.pickup.me, "233151", "同段别的字段要留着")
  assert.equal(raw.prWatch.ignoreAuthors[0], "233151")
  assert.equal(raw.workHours.offUntil, cfg.workHours.offUntil)
  assert.equal(raw.repos[0].base, "sit-20261126")

  // 没配置文件时不做任何事（CLI 单独跑的场景）
  assert.equal(persistSchedules("", { pickup: true }, cfg), false)
})

test("persistSchedules：对象 patch 同时写 enabled 与 cron", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-sched-cron-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, JSON.stringify({ router: { enabled: false, intervalSeconds: 600 }, prWatch: { enabled: true } }))
  const cfg = baseCfg()
  applySchedules(cfg, { router: { enabled: true, cron: "*/15 8-17 * * 1-5" } })
  persistSchedules(file, { router: { enabled: true, cron: "*/15 8-17 * * 1-5" } }, cfg)
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.router.enabled, true)
  assert.equal(raw.router.cron, "*/15 8-17 * * 1-5")
  assert.equal(raw.router.intervalSeconds, 600)
})

test("HTTP：/api/schedules 读写开关，/api/pickup 立刻跑一轮", async () => {
  const cfg = baseCfg()
  const calls = { pickup: 0, patches: [] }
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-http-"))
  const ctx = {
    schedules: () => listSchedules(cfg),
    workHours: () => ({ start: cfg.workHours.start, end: cfg.workHours.end }),
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
    assert.deepEqual(list.workHours, { start: "08:30", end: "17:30" })

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
        body: JSON.stringify({ patch: { workHours: { start: "08:00", end: "20:30" } } }),
      })
    ).json()
    assert.equal(hours.ok, true)
    assert.deepEqual(hours.workHours, { start: "08:00", end: "20:30" })
    assert.equal(hours.schedules.find((s) => s.id === "workHours").detail.includes("08:00–20:30"), true)

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
