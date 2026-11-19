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

test("mail.since 保留合法固定时间，拒绝非法日期", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], mail: { since: "2026-11-19T00:00:00+08:00" } })
  assert.equal(loadConfig(file).mail.since, "2026-11-19T00:00:00+08:00")
  const { file: invalid } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], mail: { since: "每天零点" } })
  assert.throws(() => loadConfig(invalid), /mail\.since/)
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

test("deliver：默认每次新建会话；提示词与监控项目只从配置读，相对路径落到配置文件同目录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-cfg-"))
  try {
    fs.writeFileSync(path.join(dir, "fixed.md"), "# 固定提示词\n")
    const file = path.join(dir, "foreman.json")
    fs.writeFileSync(
      file,
      JSON.stringify({
        repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }],
        deliver: { promptFile: "fixed.md", projectDir: "/Users/x/Documents/workspace/win-ai-stack" },
      })
    )
    const cfg = loadConfig(file)
    assert.equal(cfg.deliver.mode, "new")
    assert.equal(cfg.deliver.promptFile, path.join(dir, "fixed.md"))
    assert.equal(cfg.deliver.projectDir, "/Users/x/Documents/workspace/win-ai-stack")
    assert.equal(cfg.deliver.waitFirstReply, false)
    assert.equal(cfg.deliver.namePrefix, "foreman")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("deliver.mode 写错、提示词文件不存在都直接报错", () => {
  assert.throws(() => {
    const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], deliver: { mode: "whenever" } })
    loadConfig(file)
  }, /deliver\.mode/)
  assert.throws(() => {
    const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], deliver: { promptFile: "/definitely/not/here.md" } })
    loadConfig(file)
  }, /deliver\.promptFile/)
})

test("deliver.mode=existing 时留空提示词也合法（老行为回退）", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], deliver: { mode: "existing" } })
  const cfg = loadConfig(file)
  assert.equal(cfg.deliver.mode, "existing")
  assert.equal(cfg.deliver.promptFile, "")
})

test("pickup 自动巡检：默认关，开了才按 intervalSeconds 跑，间隔写错直接报错", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }] })
  const cfg = loadConfig(file)
  assert.equal(cfg.pickup.auto, false)
  assert.equal(cfg.pickup.intervalSeconds, 1800)
  // 派单通道默认同时 2 张单在跑，一轮也补 2 条（派活动作本身仍串行）。
  assert.equal(cfg.pickup.maxRunning, 2)
  assert.equal(cfg.pickup.maxPerRound, 2)
  assert.equal(cfg.pickup.pauseWhileRunning, false)
  // 合并通道默认关、1 并发。
  assert.equal(cfg.merge.concurrency, 1)
  assert.equal(cfg.merge.enabled, false)

  const { file: f2 } = tmpConfig({
    repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }],
    pickup: { auto: true, intervalSeconds: 900, maxPerRound: 1 },
    workHours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30" },
  })
  const c2 = loadConfig(f2)
  assert.equal(c2.pickup.auto, true)
  assert.equal(c2.pickup.intervalSeconds, 900)
  assert.equal(c2.workHours.end, "17:30")

  assert.throws(() => {
    const { file: f3 } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], pickup: { intervalSeconds: 0 } })
    loadConfig(f3)
  }, /pickup\.intervalSeconds/)
})

test("pickup.auto 只认布尔 true，字符串 \"true\" 不算开关", () => {
  const { file } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }], pickup: { auto: "true" } })
  assert.equal(loadConfig(file).pickup.auto, false)
})
