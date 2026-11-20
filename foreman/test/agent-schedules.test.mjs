// 自定义 Agent 型定时任务：首次从配置迁移 → 列表多一行 → 页面改开关/cron/提示词 → 写入 SQLite。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { listSchedules, applySchedules, hydrateSchedules, scheduleDefinitions, saveScheduleSettings } from "../src/core/schedules.mjs"
import { InboxStore, ScheduleRunner } from "../src/core/inbox.mjs"
import { loadConfig, DEFAULT_AGENT_CWD } from "../src/config.mjs"

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
  assert.deepEqual(row.agent, { prompt: entry().prompt, cwd: DEFAULT_AGENT_CWD, custom: true })
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

test("SQLite：自定义 Agent 任务按 id 持久化，重启后不被旧配置覆盖", () => {
  const store = new InboxStore(new DatabaseSync(":memory:"))
  const cfg = baseCfg()
  applySchedules(cfg, { "daily-stats": { enabled: false, cron: "30 17 * * 1-5", agent: { prompt: "新的说明" } } })
  new ScheduleRunner({ store }).sync(scheduleDefinitions(cfg))
  saveScheduleSettings(store, cfg)

  const persisted = store.schedules().find((row) => row.id === "daily-stats")
  assert.equal(persisted.enabled, false)
  assert.equal(persisted.cron, "30 17 * * 1-5")
  assert.equal(persisted.payload.prompt, "新的说明")
  assert.equal(persisted.payload.label, "下班前统计")

  const restarted = baseCfg()
  restarted.agentSchedules[0].prompt = "旧配置里的说明"
  restarted.agentSchedules[0].enabled = true
  hydrateSchedules(restarted, store)
  assert.equal(restarted.agentSchedules.length, 1)
  assert.equal(restarted.agentSchedules[0].enabled, false)
  assert.equal(restarted.agentSchedules[0].cron, "30 17 * * 1-5")
  assert.equal(restarted.agentSchedules[0].prompt, "新的说明")
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
    cwd: DEFAULT_AGENT_CWD,
    detail: "",
  })

  const badCron = tmpConfig({ agentSchedules: [{ id: "x-1", cron: "bad", prompt: "p" }] })
  assert.throws(() => loadConfig(badCron), /cron 不合法/)
  const badPrompt = tmpConfig({ agentSchedules: [{ id: "x-1", cron: "0 9 * * *", prompt: "  " }] })
  assert.throws(() => loadConfig(badPrompt), /缺少 prompt/)
  const dupId = tmpConfig({ agentSchedules: [{ id: "router", cron: "0 9 * * *", prompt: "p" }] })
  assert.throws(() => loadConfig(dupId), /与内置定时任务重名/)
})

test("cwd：省略就落在脚本所在位置，写了就按 ~ / 相对路径解析", () => {
  const cfg = loadConfig(tmpConfig({ agentSchedules: [{ id: "a-1", cron: "0 9 * * *", prompt: "p" }] }))
  assert.equal(cfg.agentSchedules[0].cwd, DEFAULT_AGENT_CWD)

  const abs = loadConfig(tmpConfig({ agentSchedules: [{ id: "a-1", cron: "0 9 * * *", prompt: "p", cwd: "/tmp/vault" }] }))
  assert.equal(abs.agentSchedules[0].cwd, "/tmp/vault")

  const home = loadConfig(tmpConfig({ agentSchedules: [{ id: "a-1", cron: "0 9 * * *", prompt: "p", cwd: "~/Doubao" }] }))
  assert.equal(home.agentSchedules[0].cwd, path.join(os.homedir(), "Doubao"))

  const rel = loadConfig(tmpConfig({ agentSchedules: [{ id: "a-1", cron: "0 9 * * *", prompt: "p", cwd: "notes" }] }))
  assert.equal(rel.agentSchedules[0].cwd, path.join(DEFAULT_AGENT_CWD, "notes"))
})

test("cwd：页面改成空串就回到默认，非空则落到 SQLite payload", () => {
  const store = new InboxStore(new DatabaseSync(":memory:"))
  const cfg = baseCfg()
  applySchedules(cfg, { "daily-stats": { agent: { cwd: "/tmp/vault" } } })
  assert.equal(cfg.agentSchedules[0].cwd, "/tmp/vault")
  new ScheduleRunner({ store }).sync(scheduleDefinitions(cfg))
  assert.equal(store.schedules().find((row) => row.id === "daily-stats").payload.cwd, "/tmp/vault")

  applySchedules(cfg, { "daily-stats": { agent: { cwd: "" } } })
  assert.equal(cfg.agentSchedules[0].cwd, DEFAULT_AGENT_CWD)
  new ScheduleRunner({ store }).sync(scheduleDefinitions(cfg))
  assert.equal(store.schedules().find((row) => row.id === "daily-stats").payload.cwd, DEFAULT_AGENT_CWD)
  assert.equal(listSchedules(cfg).find((r) => r.id === "daily-stats").cwd, DEFAULT_AGENT_CWD)
})
