// dws 只管豆包会话：配置里只要还有工单/仓库那套字段，也必须被忽略而不是报错。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, DEFAULTS } from "../src/config.mjs"

function withConfig(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dws-config-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, JSON.stringify(raw))
  try {
    return loadConfig(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("只读会话相关的键，工单/仓库/PR 字段一律忽略", () => {
  const cfg = withConfig({
    stateFile: "state.json",
    mode: "local",
    model: "auto",
    pollSeconds: 2,
    repos: [{ repo: "a/b", path: "/nope", base: "dev" }],
    pickup: { labels: ["ready-for-agent"], labelIds: [5] },
    merge: { enabled: true },
  })
  assert.equal(cfg.pollSeconds, 2)
  assert.equal(cfg.repos, undefined)
  assert.equal(cfg.pickup, undefined)
  assert.equal(cfg.merge, undefined)
  assert.equal(cfg.stateFile, path.join(cfg.dir, "state.json"))
})

test("没写配置项时用默认值", () => {
  const cfg = withConfig({})
  assert.equal(cfg.pollSeconds, DEFAULTS.pollSeconds)
  assert.equal(cfg.timeoutMinutes, DEFAULTS.timeoutMinutes)
})

test("轮询/超时写错要直接报错，不静默取默认", () => {
  assert.throws(() => withConfig({ pollSeconds: 0 }), /pollSeconds/)
  assert.throws(() => withConfig({ timeoutMinutes: "30" }), /timeoutMinutes/)
})
