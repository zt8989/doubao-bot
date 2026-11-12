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
  planner: { enabled: true, maxRunning: 2 },
  workHours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30", offUntil: "" },
})

test("listSchedules：五个开关都在（派单 / PR 扫描 / 续接 / 合并通道 / 工作时间窗）", () => {
  const cfg = baseCfg()
  const rows = listSchedules(cfg)
  assert.deepEqual(rows.map((r) => r.id), ["pickup", "prWatch", "planner", "merge", "workHours"])
  assert.equal(rows[0].enabled, false)
  assert.equal(rows[1].enabled, true)
  assert.match(rows[0].detail, /在跑上限 2/)
  assert.equal(rows[0].cron, "*/30 * * * *")
  assert.equal(rows[1].cron, "*/5 * * * *")
  // 合并通道与派单通道分开报：默认关、并发 1、按分钟扫队列。
  assert.equal(rows[3].enabled, false)
  assert.match(rows[3].detail, /并发 1/)
  assert.equal(rows[3].cron, "* * * * *")
  // 用工作日中午的时间点判断，避免跑测试时正好在窗口外
  const noon = new Date()
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
  assert.equal(cronOf(cfg, "pickup"), "*/30 * * * *")
  assert.equal(cronOf({ pickup: { cron: "0 9 * * 1-5", intervalSeconds: 1800 } }, "pickup"), "0 9 * * 1-5")
})

test("applySchedules：对象 patch 可只改 cron 或同时改开关，非法 cron 不落内存", () => {
  const cfg = baseCfg()
  const rows = applySchedules(cfg, { pickup: { cron: "*/15 8-17 * * 1-5" } })
  assert.equal(cfg.pickup.cron, "*/15 8-17 * * 1-5")
  assert.equal(cfg.pickup.auto, false, "只改时间不应顺手打开")
  assert.equal(rows[0].cron, "*/15 8-17 * * 1-5")
  applySchedules(cfg, { prWatch: { enabled: false, cron: "0 */2 * * *" } })
  assert.equal(cfg.prWatch.enabled, false)
  assert.equal(cfg.prWatch.cron, "0 */2 * * *")
  assert.throws(() => applySchedules(cfg, { pickup: { cron: "bad" } }), /cron 不合法/)
  assert.equal(cfg.pickup.cron, "*/15 8-17 * * 1-5")
  assert.throws(() => applySchedules(cfg, { planner: { cron: "* * * * *" } }), /没有 cron/)
})

test("applySchedules：翻转 pickup / prWatch / planner", () => {
  const cfg = baseCfg()
  const rows = applySchedules(cfg, { pickup: true, prWatch: false, planner: false })
  assert.equal(cfg.pickup.auto, true)
  assert.equal(cfg.prWatch.enabled, false)
  assert.equal(cfg.planner.enabled, false)
  assert.equal(rows.find((r) => r.id === "pickup").enabled, true)
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
        planner: { enabled: true, maxRunning: 2 },
        workHours: { start: "08:30", end: "17:30", days: [1, 2, 3, 4, 5] },
      },
      null,
      2
    )
  )
  const cfg = baseCfg()
  applySchedules(cfg, { pickup: true, workHours: false })
  assert.equal(persistSchedules(file, { pickup: true, workHours: false }, cfg), true)

  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.pickup.auto, true)
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
  fs.writeFileSync(file, JSON.stringify({ pickup: { auto: false, me: "233151" }, prWatch: { enabled: true } }))
  const cfg = baseCfg()
  applySchedules(cfg, { pickup: { enabled: true, cron: "*/15 8-17 * * 1-5" } })
  persistSchedules(file, { pickup: { enabled: true, cron: "*/15 8-17 * * 1-5" } }, cfg)
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.pickup.auto, true)
  assert.equal(raw.pickup.cron, "*/15 8-17 * * 1-5")
  assert.equal(raw.pickup.me, "233151")
})

test("HTTP：/api/schedules 读写开关，/api/pickup 立刻跑一轮", async () => {
  const cfg = baseCfg()
  const calls = { pickup: 0, patches: [] }
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-http-"))
  const ctx = {
    schedules: () => listSchedules(cfg),
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
    assert.equal(list.schedules.find((s) => s.id === "pickup").enabled, false)

    const set = await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { pickup: true } }),
      })
    ).json()
    assert.equal(set.ok, true)
    assert.equal(set.schedules.find((s) => s.id === "pickup").enabled, true)
    assert.deepEqual(calls.patches, [{ pickup: true }])

    const run = await (await fetch(`${base}/api/pickup`, { method: "POST" })).json()
    assert.equal(run.ok, true)
    assert.equal(calls.pickup, 1)
  } finally {
    await new Promise((r) => h.server.close(r))
  }
})
