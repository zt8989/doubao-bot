import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentExecutor, runConfiguredScript, scriptExecutor } from "../src/executors.mjs"

const cfg = () => ({ prWatch: {}, mail: {}, router: {} })

test("执行器默认配置与实际 PR、邮件脚本入口一致", async () => {
  const config = cfg()
  const pr = scriptExecutor(config, "prWatch")
  const mail = scriptExecutor(config, "mail")
  assert.deepEqual(pr, { path: "src/service.mjs", exportName: "prPollOnce", args: {} })
  assert.deepEqual(mail, { path: "src/mailflow.mjs", exportName: "mailPollOnce", args: {} })
  assert.equal(typeof (await import("../src/service.mjs"))[pr.exportName], "function")
  assert.equal(typeof (await import("../src/mailflow.mjs"))[mail.exportName], "function")
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
