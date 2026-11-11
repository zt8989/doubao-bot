import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, DEFAULT_EXCLUDE } from "../src/config.mjs"

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-cfg-"))
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj))
  return { dir, file }
}

test("默认值：只按标签 id 过滤，排除人工标签", () => {
  const { file } = tmpConfig({ repos: [{ repo: "yyzl/win-ai-harness", dir: "~/Documents/workspace/win-ai-harness", base: "sit-20261126" }] })
  const cfg = loadConfig(file)
  assert.deepEqual(cfg.pickup.labelIds, [])
  assert.deepEqual(cfg.pickup.excludeLabels, DEFAULT_EXCLUDE)
  assert.equal(cfg.maxAttempts, 3)
  assert.equal(cfg.repos[0].name, "win-ai-harness")
  assert.equal(cfg.repos[0].base, "sit-20261126")
})

test("未知键忽略不报错（老配置能继续读）", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], legacyWhatever: { x: 1 } })
  const cfg = loadConfig(file)
  assert.equal(cfg.repos.length, 1)
})

test("数值写错要报错，不静默", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], pollSeconds: "abc" })
  assert.throws(() => loadConfig(file), /pollSeconds/)
  const { file: f2 } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], timeoutMinutes: 0 })
  assert.throws(() => loadConfig(f2), /timeoutMinutes/)
})

test("repo 写错（缺 owner/ 或缺 dir）直接报错", () => {
  const { file } = tmpConfig({ repos: [{ repo: "no-slash", dir: "/tmp" }] })
  assert.throws(() => loadConfig(file), /owner\/name/)
  const { file: f2 } = tmpConfig({ repos: [{ repo: "a/b" }] })
  assert.throws(() => loadConfig(f2), /dir/)
})

test("repos[].base 必填：缺了直接报错，不静默回落 dev", () => {
  assert.throws(() => {
    const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp" }] })
    loadConfig(file)
  }, /repos\[\]\.base 必填/)
})

test("stateFile 相对路径落在配置文件同目录", () => {
  const { dir, file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }] })
  const cfg = loadConfig(file)
  assert.equal(cfg.stateFile, path.join(dir, "state.json"))
})

test("身份从配置补齐：pickup.me ↔ prWatch.ignoreAuthors", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], pickup: { me: "alice" }, prWatch: { ignoreAuthors: [] } })
  const c1 = loadConfig(file)
  assert.equal(c1.pickup.me, "alice")
  assert.deepEqual(c1.prWatch.ignoreAuthors, ["alice"])

  const { file: f2 } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], pickup: { me: "" }, prWatch: { ignoreAuthors: ["bob"] } })
  const c2 = loadConfig(f2)
  assert.equal(c2.pickup.me, "bob")
})
