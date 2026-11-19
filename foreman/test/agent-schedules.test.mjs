// 自定义 Agent 型定时任务：配置登记 → 列表多一行 → 页面改开关/cron/提示词 → 写回配置。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listSchedules, applySchedules, persistSchedules } from "../src/schedules.mjs"
import { loadConfig } from "../src/config.mjs"

const entry = () => ({
  id: "daily-stats",
  label: "下班前统计",
  cron: "25 17 * * 1-5",
  enabled: true,
  prompt: "统计今天关闭的工单与合并的 PR。",
})

const baseCfg = () => ({
  pickup: { auto: false, me: "233151" },
  prWatch: { enabled: false },
  router: { enabled: false },
  agentSchedules: [entry()],
})

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-agent-"))
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

test("listSchedules：自定义 Agent 任务独立成行，状态取运行时", () => {
  const cfg = baseCfg()
  const rows = listSchedules(cfg, {
    agentSchedules: {
      "daily-stats": { lastAt: "2026-11-19T09:25:00.000Z", count: 2, lastResult: "已派发 foreman-daily-stats-20261119-1725", nextAt: "2026-11-20T09:25:00.000Z" },
    },
  })
  const row = rows.find((r) => r.id === "daily-stats")
  assert.equal(row.executor, "agent")
  assert.equal(row.label, "下班前统计")
  assert.equal(row.cron, "25 17 * * 1-5")
  assert.deepEqual(row.agent, { prompt: entry().prompt, custom: true })
  assert.equal(row.enabled, true)
  assert.equal(row.count, 2)
  assert.equal(row.lastAt, "2026-11-19T09:25:00.000Z")
  assert.match(row.lastResult, /已派发/)
  assert.equal(row.nextAt, "2026-11-20T09:25:00.000Z")
  assert.equal(row.runnable, true)
  assert.equal(row.runLabel, "立即执行")
})

test("applySchedules：自定义 Agent 任务可改开关、cron 与提示词", () => {
  const cfg = baseCfg()
  applySchedules(cfg, { "daily-stats": { enabled: false, cron: "30 17 * * 1-5", agent: { prompt: "改成新的任务说明。" } } })
  const item = cfg.agentSchedules[0]
  assert.equal(item.enabled, false)
  assert.equal(item.cron, "30 17 * * 1-5")
  assert.equal(item.prompt, "改成新的任务说明。")
  const row = listSchedules(cfg).find((r) => r.id === "daily-stats")
  assert.equal(row.enabled, false)
  assert.equal(row.agent.prompt, "改成新的任务说明。")
})

test("applySchedules：自定义任务拒绝脚本、空提示词与非法 cron", () => {
  const cfg = baseCfg()
  assert.throws(() => applySchedules(cfg, { "daily-stats": { script: { path: "x.mjs", exportName: "f" } } }), /不是脚本执行器/)
  assert.throws(() => applySchedules(cfg, { "daily-stats": { agent: { prompt: "  " } } }), /提示词不能为空/)
  assert.throws(() => applySchedules(cfg, { "daily-stats": { cron: "bad" } }), /cron 不合法/)
  assert.equal(cfg.agentSchedules[0].cron, "25 17 * * 1-5")
})

test("persistSchedules：按 id 原地写回，不动条目里的其他字段", () => {
  const file = tmpConfig({ agentSchedules: [{ ...entry(), note: "用户自己写的备注" }] })
  const cfg = { agentSchedules: [entry()] }
  const patch = { "daily-stats": { enabled: false, cron: "30 17 * * 1-5", agent: { prompt: "新的说明" } } }
  applySchedules(cfg, patch)
  assert.equal(persistSchedules(file, patch, cfg), true)
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.agentSchedules[0].enabled, false)
  assert.equal(raw.agentSchedules[0].cron, "30 17 * * 1-5")
  assert.equal(raw.agentSchedules[0].prompt, "新的说明")
  assert.equal(raw.agentSchedules[0].note, "用户自己写的备注")
})

test("loadConfig：自定义 Agent 任务做 id/cron/提示词校验", () => {
  const file = tmpConfig({
    repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }],
    agentSchedules: [{ id: "daily-stats", label: "下班前统计", cron: "25 17 * * 1-5", prompt: "统计一下。" }],
  })
  const cfg = loadConfig(file)
  assert.equal(cfg.agentSchedules.length, 1)
  assert.deepEqual(cfg.agentSchedules[0], {
    id: "daily-stats",
    label: "下班前统计",
    cron: "25 17 * * 1-5",
    enabled: true,
    prompt: "统计一下。",
    detail: "",
  })

  const badCron = tmpConfig({ agentSchedules: [{ id: "x-1", cron: "bad", prompt: "p" }] })
  assert.throws(() => loadConfig(badCron), /cron 不合法/)
  const badPrompt = tmpConfig({ agentSchedules: [{ id: "x-1", cron: "0 9 * * *", prompt: "  " }] })
  assert.throws(() => loadConfig(badPrompt), /缺少 prompt/)
  const dupId = tmpConfig({ agentSchedules: [{ id: "router", cron: "0 9 * * *", prompt: "p" }] })
  assert.throws(() => loadConfig(dupId), /与内置定时任务重名/)
})
