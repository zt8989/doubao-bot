import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { agentExecutor, runConfiguredScript, scriptExecutor, SCHEDULE_SCRIPT_DIR } from "../src/core/executors.mjs"

const cfg = () => ({ prWatch: {}, mail: {}, router: {} })

test("执行器默认配置指向独立的定时脚本目录，导出函数与脚本一致", async () => {
  const config = cfg()
  const pickup = scriptExecutor(config, "pickup")
  const pr = scriptExecutor(config, "prWatch")
  const router = scriptExecutor(config, "router")
  const mail = scriptExecutor(config, "mail")
  assert.deepEqual(pickup, { path: `${SCHEDULE_SCRIPT_DIR}/pickup.mjs`, exportName: "pickupPollOnce", args: {} })
  assert.deepEqual(pr, { path: `${SCHEDULE_SCRIPT_DIR}/prwatch.mjs`, exportName: "prPollOnce", args: {} })
  assert.deepEqual(router, { path: `${SCHEDULE_SCRIPT_DIR}/router.mjs`, exportName: "pollOnce", args: {} })
  assert.deepEqual(mail, { path: `${SCHEDULE_SCRIPT_DIR}/mail.mjs`, exportName: "mailPollOnce", args: {} })
  for (const exec of [pickup, pr, router, mail]) {
    assert.ok(path.isAbsolute(exec.path), `脚本路径必须是绝对路径：${exec.path}`)
    const mod = await import(pathToFileURL(exec.path).href)
    assert.equal(typeof mod[exec.exportName], "function")
  }
  assert.equal(agentExecutor(config).custom, false)
  assert.ok(agentExecutor(config).prompt.length > 100)
})

test("runConfiguredScript 动态调用配置的导出函数，并传入原始 JSON 参数", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-script-executor-"))
  const file = path.join(dir, "fixture.mjs")
  fs.writeFileSync(file, "export async function collect(ctx, args) { return { ok: true, marker: ctx.marker, args } }\n")
  const config = cfg()
  config.mail.script = { path: file, exportName: "collect", args: { limit: 3, nested: { labels: ["ready"] } } }
  const result = await runConfiguredScript({ cfg: config, marker: "same-ctx" }, "mail")
  assert.equal(result.ok, true)
  assert.equal(result.marker, "same-ctx")
  assert.deepEqual(result.args, { limit: 3, nested: { labels: ["ready"] } })
})

test("PR 手动执行覆盖 force，自定义其他参数保持原样", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-pr-executor-"))
  const file = path.join(dir, "fixture.mjs")
  fs.writeFileSync(file, "export async function scan(ctx, args) { return args }\n")
  const config = cfg()
  config.prWatch.script = { path: file, exportName: "scan", args: { source: "settings", force: false } }
  assert.deepEqual(await runConfiguredScript({ cfg: config }, "prWatch", { manual: true }), { source: "settings", force: true })
  assert.deepEqual(await runConfiguredScript({ cfg: config }, "prWatch", { manual: false }), { source: "settings", force: false })
})

test("脚本加载与导出函数错误给出可定位的信息", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-script-error-"))
  const file = path.join(dir, "fixture.mjs")
  fs.writeFileSync(file, "export const value = 42\n")
  const config = cfg()
  config.mail.script = { path: file, exportName: "missing", args: {} }
  await assert.rejects(() => runConfiguredScript({ cfg: config }, "mail"), /没有导出函数 missing/)
  config.mail.script.path = path.join(dir, "not-found.mjs")
  await assert.rejects(() => runConfiguredScript({ cfg: config }, "mail"), /加载定时脚本失败/)
})
