import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const BIN = fileURLToPath(new URL("../bin/foreman.mjs", import.meta.url))

function fixture(memoryConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-memory-"))
  const config = path.join(dir, "foreman.json")
  fs.writeFileSync(config, JSON.stringify({ service: { enabled: false }, memory: { dir: "memory", ...memoryConfig } }))
  return { dir, config }
}

function memory(f, args, { ok = true } = {}) {
  const result = spawnSync(process.execPath, [BIN, "memory", ...args, "--config", f.config, "--no-service"], {
    encoding: "utf8",
  })
  if (ok) {
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.notEqual(result.status, 0, result.stdout)
  return result.stderr
}

function memoryAsync(f, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "memory", ...args, "--config", f.config, "--no-service"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `退出码 ${code}`))
      resolve(JSON.parse(stdout))
    })
  })
}

test("多个 agent 并发写入不同 key 时不丢失核心记忆", async () => {
  const f = fixture()
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      memoryAsync(f, ["set", "--target", "memory", "--key", `concurrent-${index}`, "--text", `并发记忆 ${index}`])
    ))
    assert.equal(memory(f, ["show"]).memory.entries, 12)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("forget 通过命令删除指定核心条目", () => {
  const f = fixture()
  try {
    memory(f, ["set", "--target", "user", "--key", "reply-language", "--text", "始终使用简体中文回复"])
    const removed = memory(f, ["forget", "--target", "user", "--key", "reply-language"])
    assert.equal(removed.action, "deleted")
    assert.equal(memory(f, ["show"]).user.entries, 0)
    assert.equal(memory(f, ["search", "简体中文"]).results.length, 0)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("日常笔记不进入核心文件，search 按需检索笔记与核心记忆", () => {
  const f = fixture()
  try {
    memory(f, ["set", "--target", "memory", "--key", "release-branch", "--text", "发布统一使用 master 分支"])
    memory(f, ["note", "--text", "今天排查了发布超时，原因是健康检查等待过短"])

    const shown = memory(f, ["show"])
    assert.doesNotMatch(shown.memory.content, /健康检查/)
    assert.doesNotMatch(shown.user.content, /健康检查/)

    const episodic = memory(f, ["search", "发布超时"])
    assert.equal(episodic.results.length, 1)
    assert.equal(episodic.results[0].tier, "episodic")
    assert.match(episodic.results[0].file, /^memory\/\d{4}-\d{2}-\d{2}\.md$/)
    assert.match(episodic.results[0].text, /健康检查等待过短/)

    const curated = memory(f, ["search", "master"])
    assert.equal(curated.results.length, 1)
    assert.equal(curated.results[0].tier, "curated")
    assert.equal(curated.results[0].file, "MEMORY.md")
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("写入时超限直接报错，不自动精简、不截断、不破坏原文件", () => {
  const f = fixture({ maxEntryChars: 10, memoryMaxBytes: 140 })
  try {
    const tooLong = memory(f, ["set", "--target", "memory", "--key", "long", "--text", "这是一条明显超过十个字符的记忆"], { ok: false })
    assert.match(tooLong, /单条.*10/)
    assert.equal(memory(f, ["show"]).memory.entries, 0)

    memory(f, ["set", "--target", "memory", "--key", "first", "--text", "短记忆"])
    const before = memory(f, ["show"]).memory.content
    const tooLarge = memory(f, ["set", "--target", "memory", "--key", "second", "--text", "第二条记忆会超限"], { ok: false })
    assert.match(tooLarge, /MEMORY\.md.*140/)
    assert.match(tooLarge, /不会自动精简|请精简/)
    assert.equal(memory(f, ["show"]).memory.content, before)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("memory set 按稳定 key 原地替代，show 分别返回 MEMORY 与 USER", () => {
  const f = fixture()
  try {
    memory(f, ["set", "--target", "memory", "--key", "release-branch", "--text", "发布统一使用 sit 分支"])
    memory(f, ["set", "--target", "memory", "--key", "release-branch", "--text", "发布统一使用 master 分支"])
    memory(f, ["set", "--target", "user", "--key", "reply-language", "--text", "始终使用简体中文回复"])

    const shown = memory(f, ["show"])
    assert.match(shown.memory.content, /发布统一使用 master 分支/)
    assert.doesNotMatch(shown.memory.content, /发布统一使用 sit 分支/)
    assert.match(shown.memory.content, /key:release-branch/)
    assert.equal(shown.memory.entries, 1)
    assert.match(shown.user.content, /始终使用简体中文回复/)
    assert.equal(shown.user.entries, 1)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
