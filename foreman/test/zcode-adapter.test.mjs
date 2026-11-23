import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ZcodeSessionAdapter } from "../src/workflow/adapters/zcode.mjs"
import { makeSessionAdapter, assertSessionAdapter } from "../src/workflow/adapters/session.mjs"
import { resolveZcodeCommand, ZcodeDriver } from "../src/zcodedrv.mjs"
import { loadConfig } from "../src/config.mjs"

const FIXTURE = path.join(import.meta.dirname, "fixtures", "zcode-fake.cjs")

function tmpDir(prefix = "foreman-zcode-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function tmpConfig(obj) {
  const dir = tmpDir("foreman-cfg-")
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

function makeAdapter({ zopts = {}, logs } = {}) {
  const dir = tmpDir()
  const got = logs ?? []
  const adapter = new ZcodeSessionAdapter({
    cfg: { stateFile: path.join(dir, "state.json"), agent: "zcode", zcode: { bin: `node ${FIXTURE}`, ...zopts } },
    log: (m) => got.push(m),
  })
  return { adapter, dir, logs: got }
}

test("resolveZcodeCommand：显式命令 > PATH 上的 zcode > ZCode.app 内置 cjs", () => {
  // 显式带空格的一条命令（wrapper / 测试假 bin）
  assert.deepEqual(resolveZcodeCommand("node /x/fake.cjs"), { cmd: "node", baseArgs: ["/x/fake.cjs"] })
  // 显式 .cjs 路径自动用当前 node 跑
  const viaNode = resolveZcodeCommand("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", { exists: () => false })
  assert.equal(viaNode.cmd, process.execPath)
  assert.deepEqual(viaNode.baseArgs, ["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"])
  // PATH 上有 zcode 就用 PATH 的
  assert.deepEqual(resolveZcodeCommand("", { exists: (p) => p === "/usr/local/bin/zcode", platform: "darwin" }), {
    cmd: "/usr/local/bin/zcode",
    baseArgs: [],
  })
  // 啥都没有也别炸：留个裸命令让 run() 报 bin_missing
  assert.deepEqual(resolveZcodeCommand("", { exists: () => false, platform: "linux" }), { cmd: "zcode", baseArgs: [] })
  // 显式可执行名原样透传
  assert.deepEqual(resolveZcodeCommand("zc"), { cmd: "zc", baseArgs: [] })
})

test("zcode 适配器：契约方法齐全，工厂按 agent=zcode 选中", async () => {
  const { adapter } = makeAdapter()
  assertSessionAdapter(adapter, "zcode")
  assert.equal(adapter.capabilities.singleInstance, false)
  assert.deepEqual(await adapter.busyWatchers(), [])
  assert.equal(makeSessionAdapter({ agent: "zcode" }).constructor.name, "ZcodeSessionAdapter")
  assert.equal(makeSessionAdapter({ agent: "ZCode" }).constructor.name, "ZcodeSessionAdapter")
})

test("openExecution：阻塞跑完首轮，convId 是 sess id，status/info/runningMap 都能读", async () => {
  const { adapter, logs } = makeAdapter()
  const out = await adapter.openExecution({ name: "工单编排", repo: "/tmp/repo-a", prompt: "你好" })
  assert.equal(out.ok, true)
  assert.match(out.convId, /^sess_fake-/)
  assert.match(out.response, /reply/)

  const st = await adapter.status("工单编排")
  assert.equal(st.streaming, false)
  assert.equal(st.finished, true)
  assert.ok(st.chars > 0)
  assert.equal(st.reply.finished, true)

  const info = await adapter.info(out.convId)
  assert.match(info.lastReply, /reply/)
  assert.match(info.lastReply, /你好/)
  assert.match(info.lastReply, /@cwd:\/tmp\/repo-a/)

  const map = await adapter.runningMap()
  assert.deepEqual(map[out.convId], { running: false, title: "工单编排", active: false })

  // 名字与 sess id 互查：按 sess id 也能拿到同一条
  const byId = await adapter.info(out.convId)
  assert.equal(byId.name, "工单编排")
  assert.ok(logs.some((m) => m.includes("zcode open 工单编排")))
})

test("resumeExecution：同名续说不丢上下文（fake 靠 --resume 返回同一 sessionId）", async () => {
  const { adapter } = makeAdapter()
  const first = await adapter.openExecution({ name: "会话", prompt: "第一轮" })
  const sessionId = adapter.driver.resolve("会话").sessionId
  assert.equal(sessionId, first.convId)

  await adapter.resumeExecution({ name: "会话", prompt: "第二轮" })
  const entry = adapter.driver.resolve("会话")
  // fake 收到 --resume 就回同一 id：说明续说真的带上了会话，而不是新开
  assert.equal(entry.sessionId, sessionId)
  assert.match(entry.lastReply, /第二轮/)
})

test("deliver noWait：立刻返回伪 id 且在跑，跑完回填 sess id、伪 id 依旧可查", async () => {
  const { adapter } = makeAdapter({ zopts: {} })
  process.env.ZCODE_FAKE_DELAY_MS = "400"
  try {
    const out = await adapter.deliver({ name: "通知会话", prompt: "首句" })
    assert.equal(out.ok, true)
    assert.match(out.convId, /^zcode-/)

    const running = await adapter.status(out.convId)
    assert.equal(running.streaming, true)
    assert.equal(running.finished, false)
    const map = await adapter.runningMap()
    assert.equal(map[out.convId].running, true)

    const last = await adapter.driver.waitFinished(out.convId, { timeoutMs: 10000, pollMs: 100 })
    assert.equal(last.finished, true)
    // 跑完：伪 id 依旧解析，sess id 也回填了
    assert.match(adapter.driver.resolve(out.convId).sessionId, /^sess_fake-/)
    const info = await adapter.info(out.convId)
    assert.match(info.lastReply, /首句/)
    const map2 = await adapter.runningMap()
    assert.equal(map2[out.convId].running, false)
    assert.equal(map2[adapter.driver.resolve(out.convId).sessionId].running, false)
  } finally {
    delete process.env.ZCODE_FAKE_DELAY_MS
  }
})

test("steer/notify：排到当前轮次之后后台跑（跑完后 lastReply 是 steer 那轮的）", async () => {
  const { adapter } = makeAdapter()
  process.env.ZCODE_FAKE_DELAY_MS = "300"
  try {
    const out = await adapter.deliver({ name: "工作会话", prompt: "首轮" })
    // 上一轮还在跑时 steer 立刻返回（排队语义），不会并行 --resume 开新会话
    const steered = await adapter.steer("工作会话", "更新：改口径")
    assert.equal(steered.ok, true)
    assert.equal(steered.background, true)

    await adapter.driver.waitFinished(out.convId, { timeoutMs: 10000, pollMs: 100 })
    const info = await adapter.info(out.convId)
    assert.match(info.lastReply, /更新：改口径/)
    // 两轮同一会话：sessionId 没变
    assert.match(adapter.driver.resolve(out.convId).sessionId, /^sess_fake-/)
    assert.equal(adapter.driver.resolve("工作会话").sessionId, adapter.driver.resolve(out.convId).sessionId)

    // 按 sess id 目标 notify 也能解析
    const sess = adapter.driver.resolve(out.convId).sessionId
    const notified = await adapter.notify(sess, "按 id 通知")
    assert.equal(notified.ok, true)
    await adapter.driver.waitFinished(sess, { timeoutMs: 10000, pollMs: 100 })
    assert.match((await adapter.info(sess)).lastReply, /按 id 通知/)
  } finally {
    delete process.env.ZCODE_FAKE_DELAY_MS
  }
})

test("超长 prompt 走 --attach（fake 回读附件内容）", async () => {
  const { adapter } = makeAdapter()
  const big = "长指令".repeat(40 * 1024) // > 90KB
  assert.ok(Buffer.byteLength(big, "utf8") > 90 * 1024)
  await adapter.openExecution({ name: "大提示词", prompt: big })
  const info = await adapter.info("大提示词")
  assert.ok(info.lastReply.startsWith("reply("))
  assert.ok(info.lastReply.includes("[attach]"))
  assert.ok(info.lastReply.includes("长指令"))
})

test("未知目标：status 报账本缺失；archive 幂等且清账", async () => {
  const { adapter } = makeAdapter()
  await assert.rejects(adapter.status("从没派过"), /账本里没有会话/)

  const out = await adapter.openExecution({ name: "归档我", prompt: "x" })
  assert.equal((await adapter.archive("归档我")).ok, true)
  await assert.rejects(adapter.status("归档我"), /账本里没有会话/)
  await assert.rejects(adapter.status(out.convId), /账本里没有会话/)
  // 再归档一次也 ok（幂等）
  assert.equal((await adapter.archive("归档我")).ok, true)
  assert.deepEqual(await adapter.runningMap(), {})
})

test("send 失败透出真实错误；账本跨实例持久（新驱动读旧账本）", async () => {
  const { adapter, dir } = makeAdapter()
  process.env.ZCODE_FAKE_FAIL = "not logged in"
  try {
    await assert.rejects(adapter.openExecution({ name: "会失败", prompt: "x" }), /zcode 没有登录|not logged in/)
    assert.equal(adapter.driver.resolve("会失败").status, "error")
  } finally {
    delete process.env.ZCODE_FAKE_FAIL
  }

  // 账本落在 stateFile 同目录：换个驱动实例还能解析旧会话
  const ledgerFile = path.join(dir, "zcode-sessions.json")
  assert.ok(fs.existsSync(ledgerFile))
  const second = new ZcodeDriver({ bin: `node ${FIXTURE}`, ledger: ledgerFile })
  assert.match(second.resolve("会失败").lastReply ?? "", /^$/)
  assert.equal(second.resolve("会失败").status, "error")
})

test("配置：agent 只认 noop/dws/zcode，默认 noop，写错兜底 noop；zcode 段默认齐", () => {
  assert.equal(loadConfig(tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit" }] })).agent, "noop")
  assert.equal(loadConfig(tmpConfig({ agent: "zcode" })).agent, "zcode")
  assert.equal(loadConfig(tmpConfig({ agent: "dws" })).agent, "dws")
  assert.equal(loadConfig(tmpConfig({ agent: "noop" })).agent, "noop")
  assert.equal(loadConfig(tmpConfig({ agent: "豆包" })).agent, "noop")
  const cfg = loadConfig(tmpConfig({ agent: "zcode" }))
  assert.deepEqual(cfg.zcode, { bin: "", mode: "", ledger: "" })
})
