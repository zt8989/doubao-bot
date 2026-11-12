import test from "node:test"
import assert from "node:assert/strict"
import { inWorkHours } from "../src/util.mjs"

const W = { enabled: true, days: [1, 2, 3, 4, 5], start: "08:30", end: "18:30" }

test("没配 workHours 或 enabled=false：全天都算工作时间", () => {
  assert.equal(inWorkHours({}, new Date("2026-11-11T23:00:00+08:00")), true)
  assert.equal(inWorkHours({ workHours: { enabled: false } }, new Date("2026-11-11T23:00:00+08:00")), true)
})

test("工作日窗口内 true，窗口外 false", () => {
  const cfg = { workHours: W }
  assert.equal(inWorkHours(cfg, new Date("2026-11-11T08:29:00+08:00")), false)
  assert.equal(inWorkHours(cfg, new Date("2026-11-11T08:30:00+08:00")), true)
  assert.equal(inWorkHours(cfg, new Date("2026-11-11T18:29:00+08:00")), true)
  assert.equal(inWorkHours(cfg, new Date("2026-11-11T18:30:00+08:00")), false)
})

test("周末整天空闲", () => {
  const cfg = { workHours: W }
  assert.equal(inWorkHours(cfg, new Date("2026-11-14T10:00:00+08:00")), false) // 周六
  assert.equal(inWorkHours(cfg, new Date("2026-11-15T10:00:00+08:00")), false) // 周日
})

test("offUntil 未到：即使在工作窗口也不跑；到点恢复", () => {
  const cfg = { workHours: { ...W, offUntil: "2026-11-12T08:30:00+08:00" } }
  assert.equal(inWorkHours(cfg, new Date("2026-11-11T10:00:00+08:00")), false)
  assert.equal(inWorkHours(cfg, new Date("2026-11-12T08:30:00+08:00")), true)
})
