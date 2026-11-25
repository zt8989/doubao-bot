import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ZcodeSessionAdapter } from "../src/workflow/adapters/zcode.mjs"
import { makeSessionAdapter, assertSessionAdapter } from "../src/workflow/adapters/session.mjs"
import { resolveZcodeCommand, resolveHerdrCommand, resolveZcodeRuntimeCjs } from "../src/zcodedrv.mjs"
import { loadConfig } from "../src/config.mjs"

const HERDR_FAKE = path.join(import.meta.dirname, "fixtures", "herdr-fake.mjs")
const RUNTIME_FAKE = path.join(import.meta.dirname, "fixtures", "zcode-runtime-fake.cjs")

function tmpDir(prefix = "foreman-zcode-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function tmpConfig(obj) {
  const dir = tmpDir("foreman-cfg-")
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

// herdr 载体的适配器：假 herdr CLI + 假 runtime，状态隔离到临时目录。
function makeHerdrAdapter({ logs, workMs, block } = {}) {
  const dir = tmpDir()
  const got = logs ?? []
  const stateFile = path.join(dir, "herdr-fake-state.json")
  process.env.HERDR_FAKE_STATE = stateFile
  if (workMs) process.env.HERDR_FAKE_WORK_MS = String(workMs)
  else delete process.env.HERDR_FAKE_WORK_MS
  if (block) process.env.HERDR_FAKE_BLOCK = "1"
  else delete process.env.HERDR_FAKE_BLOCK
  // 插件检查走 ZCODE_CLI_SETTINGS_FILE：伪造一个挂了 herdr-zcode 的 setting.json
  const pluginDir = path.join(dir, "fake-plugin")
  fs.mkdirSync(path.join(pluginDir, ".zcode-plugin"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, ".zcode-plugin", "plugin.json"), JSON.stringify({ name: "herdr-zcode", version: "0.0.0" }))
  fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ plugins: { dirs: [pluginDir] } }))
  const prevSettings = process.env.ZCODE_CLI_SETTINGS_FILE
  process.env.ZCODE_CLI_SETTINGS_FILE = path.join(dir, "setting.json")
  const adapter = new ZcodeSessionAdapter({
    cfg: {
      stateFile: path.join(dir, "state.json"),
      agent: "zcode",
      zcode: { bin: `node ${RUNTIME_FAKE}`, ledger: path.join(dir, "zcode-sessions.json") },
      herdr: { bin: `node ${HERDR_FAKE}`, enabled: true },
    },
    log: (m) => got.push(m),
  })
  const cleanup = () => {
    delete process.env.HERDR_FAKE_STATE
    delete process.env.HERDR_FAKE_WORK_MS
    delete process.env.HERDR_FAKE_BLOCK
    if (prevSettings === undefined) delete process.env.ZCODE_CLI_SETTINGS_FILE
    else process.env.ZCODE_CLI_SETTINGS_FILE = prevSettings
  }
  return { adapter, dir, logs: got, cleanup }
}

test("resolveZcodeCommand：显式命令 > PATH 上的 zcode", () => {
  // 显式带空格的一条命令（wrapper / 测试假 bin）
  assert.deepEqual(resolveZcodeCommand("node /x/fake.cjs"), { cmd: "node", baseArgs: ["/x/fake.cjs"] })
  // PATH 上有 zcode 就用 PATH 的
  assert.deepEqual(resolveZcodeCommand("", { exists: (p) => p === "/usr/local/bin/zcode", platform: "darwin" }), {
    cmd: "/usr/local/bin/zcode",
    baseArgs: [],
  })
  // 啥都没有也别炸：留个裸命令让 start() 报可读错误
  assert.deepEqual(resolveZcodeCommand("", { exists: () => false, platform: "linux" }), { cmd: "zcode", baseArgs: [] })
  // 显式可执行名原样透传
  assert.deepEqual(resolveZcodeCommand("zc"), { cmd: "zc", baseArgs: [] })
})

test("resolveHerdrCommand：与 zcode 同一套解析规则（无桌面兜底）", () => {
  assert.deepEqual(resolveHerdrCommand("node /x/fake.mjs"), { cmd: "node", baseArgs: ["/x/fake.mjs"] })
  assert.deepEqual(resolveHerdrCommand("", { exists: (p) => p === "/opt/hb/bin/herdr", pathEnv: "/opt/hb/bin:/usr/bin" }), { cmd: "/opt/hb/bin/herdr", baseArgs: [] })
  assert.deepEqual(resolveHerdrCommand("", { exists: () => false, pathEnv: "/opt/hb/bin", platform: "linux" }), { cmd: "herdr", baseArgs: [] })
})

test("resolveZcodeRuntimeCjs：pane 里要的是裸 runtime，不是启动器", () => {
  // 显式 tuiBin 优先
  assert.deepEqual(resolveZcodeRuntimeCjs("node /x/zcode.cjs", { cmd: "zcode", baseArgs: [] }), { cmd: "node", baseArgs: ["/x/zcode.cjs"] })
  // bin 配置本身就是 .cjs：直接用
  assert.deepEqual(resolveZcodeRuntimeCjs("", { cmd: "node", baseArgs: ["/x/runtime.cjs"] }), { cmd: "node", baseArgs: ["/x/runtime.cjs"] })
  // npm 全局 bin（bin/zcode.js，可能经无扩展名符号链接）→ 同包 vendor/zcode.cjs
  const pkg = tmpDir("fake-pkg-")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.mkdirSync(path.join(pkg, "vendor"), { recursive: true })
  fs.writeFileSync(path.join(pkg, "bin", "zcode.js"), "// launcher")
  fs.writeFileSync(path.join(pkg, "vendor", "zcode.cjs"), "// runtime")
  const fromLauncher = resolveZcodeRuntimeCjs("", { cmd: path.join(pkg, "bin", "zcode.js"), baseArgs: [] })
  assert.equal(fromLauncher.cmd, process.execPath)
  const realPkg = fs.realpathSync(pkg) // cmd 走 realpath（/tmp → /private/tmp 这类）
  assert.deepEqual(fromLauncher.baseArgs, [path.join(realPkg, "vendor", "zcode.cjs")])
  // 无扩展名符号链接（npm -g 的真实形态）也要能解析回包
  const link = path.join(tmpDir("fake-link-"), "zcode")
  fs.symlinkSync(path.join(pkg, "bin", "zcode.js"), link)
  const fromLink = resolveZcodeRuntimeCjs("", { cmd: link, baseArgs: [] })
  assert.deepEqual(fromLink.baseArgs, [path.join(realPkg, "vendor", "zcode.cjs")])
  // 兜底：别的脚本按原样跑（测试假 bin 就是这种）
  assert.deepEqual(resolveZcodeRuntimeCjs("", { cmd: "node", baseArgs: ["/x/other.js"] }), { cmd: "node", baseArgs: ["/x/other.js"] })
})

test("zcode 适配器：契约方法齐全，工厂按 agent=zcode 选中", async () => {
  const { adapter, cleanup } = makeHerdrAdapter()
  try {
    assertSessionAdapter(adapter, "zcode")
    assert.equal(adapter.capabilities.singleInstance, false)
    assert.deepEqual(await adapter.busyWatchers(), [])
    assert.equal(makeSessionAdapter({ agent: "zcode" }).constructor.name, "ZcodeSessionAdapter")
    assert.equal(makeSessionAdapter({ agent: "ZCode" }).constructor.name, "ZcodeSessionAdapter")
  } finally {
    cleanup()
  }
})

test("herdr open：阻塞跑完首轮，convId=pane 句柄，回复与轮次留痕都在", async () => {
  const { adapter, cleanup, logs } = makeHerdrAdapter({ workMs: 300 })
  try {
    const out = await adapter.openExecution({ name: "工单A", repo: "/tmp/repo-a", prompt: "你好" })
    assert.equal(out.ok, true)
    assert.match(out.convId, /^ws\d+:p1$/)
    assert.match(out.response, /reply\(你好\)/)

    const entry = adapter.driver.resolve("工单A")
    assert.equal(entry.convId, out.convId)
    assert.equal(entry.status, "done")

    const st = await adapter.status("工单A")
    assert.equal(st.streaming, false)
    assert.equal(st.finished, true)
    assert.ok(st.chars > 0)
    assert.equal(st.reply.finished, true)

    const info = await adapter.info("工单A")
    assert.match(info.lastReply, /reply\(你好\)/)
    assert.equal(info.messages.length, 2)
    assert.equal(info.messages[0].role, "user")
    assert.ok(logs.some((m) => m.includes("zcode open 工单A")))
  } finally {
    cleanup()
  }
})

test("herdr 续说与 steer：同一 pane、seq 推进、排队后台语义不变", async () => {
  const { adapter, cleanup } = makeHerdrAdapter({ workMs: 200 })
  try {
    const first = await adapter.openExecution({ name: "会话B", prompt: "第一轮" })
    const paneId = adapter.driver.resolve("会话B").paneId

    await adapter.resumeExecution({ name: "会话B", prompt: "第二轮" })
    const entry = adapter.driver.resolve("会话B")
    assert.equal(entry.paneId, paneId, "续说不换 pane")
    assert.match(entry.lastReply, /reply\(第二轮\)/)

    const steered = await adapter.steer("会话B", "后台补一句")
    assert.equal(steered.ok, true)
    assert.equal(steered.background, true)
    const last = await adapter.driver.waitFinished(first.convId, { timeoutMs: 15000, pollMs: 200 })
    assert.equal(last.finished, true)
    assert.match((await adapter.info("会话B")).lastReply, /reply\(后台补一句\)/)
  } finally {
    cleanup()
  }
})

test("herdr deliver noWait：伪 id 立刻返回，跑完回填，runningMap 反映 running", async () => {
  const { adapter, cleanup } = makeHerdrAdapter({ workMs: 2500 })
  try {
    const out = await adapter.deliver({ name: "后台会话", prompt: "首句" })
    assert.equal(out.ok, true)
    assert.match(out.convId, /^zcode-/)
    assert.equal(out.background, true)

    const running = await adapter.status(out.convId)
    assert.equal(running.streaming, true)
    // 整包跑时机器忙，等 runningMap 反映出 running（最多 10s）
    let mapRunning = false
    for (let i = 0; i < 20 && !mapRunning; i++) {
      mapRunning = (await adapter.runningMap())[out.convId]?.running === true
      if (!mapRunning) await new Promise((r) => setTimeout(r, 500))
    }
    assert.equal(mapRunning, true)

    const last = await adapter.driver.waitFinished(out.convId, { timeoutMs: 30000, pollMs: 500 })
    assert.equal(last.finished, true)
    assert.match((await adapter.info(out.convId)).lastReply, /reply\(首句\)/)
    const map2 = await adapter.runningMap()
    assert.equal(map2[out.convId].running, false)
  } finally {
    cleanup()
  }
})

test("herdr 超长 prompt：转临时文件指路，agent 读文件内容可回显", async () => {
  const { adapter, cleanup } = makeHerdrAdapter({ workMs: 200 })
  try {
    const big = "长指令".repeat(40 * 1024) // > 90KB
    await adapter.openExecution({ name: "大提示词", prompt: big })
    const info = await adapter.info("大提示词")
    assert.match(info.lastReply, /reply\(attach\)/)
    assert.ok(info.lastReply.includes("长指令"))
  } finally {
    cleanup()
  }
})

test("herdr blocked：权限待批时立刻报错，archive 收尾", async () => {
  const { adapter, cleanup } = makeHerdrAdapter({ workMs: 200, block: true })
  try {
    await assert.rejects(adapter.openExecution({ name: "卡权限", prompt: "x" }), /权限|agent_blocked/)
    assert.equal(adapter.driver.resolve("卡权限").status, "error")
    assert.equal((await adapter.archive("卡权限")).ok, true)
    assert.deepEqual(await adapter.runningMap(), {})
  } finally {
    cleanup()
  }
})

test("herdr stop：给 working 的 pane 发 escape 打断", async () => {
  const { adapter, cleanup } = makeHerdrAdapter({ workMs: 60000 })
  try {
    const out = await adapter.deliver({ name: "长任务", prompt: "慢慢干" })
    // 等 pane 建好、prompt 提交进 fake（working）
    for (let i = 0; i < 40; i++) {
      const e = adapter.driver.resolve(out.convId)
      if (e?.paneId) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const stopped = adapter.driver.stop(out.convId)
    assert.equal(stopped.ok, true)
    await adapter.driver.waitFinished(out.convId, { timeoutMs: 15000, pollMs: 200 })
    assert.equal((await adapter.status(out.convId)).finished, true)
  } finally {
    cleanup()
  }
})

test("herdr start（doctor 探活）：版本/server/runtime/插件四项全过", async () => {
  const { adapter, cleanup } = makeHerdrAdapter()
  try {
    const started = await adapter.driver.start()
    assert.equal(started.ok, true)
    assert.match(started.version, /herdr 0\.9\.5/)
    assert.match(started.version, /zcode-runtime 0\.18\.0-fake/)
  } finally {
    cleanup()
  }
})

test("herdr archive：关 workspace 清账本，幂等", async () => {
  const { adapter, cleanup } = makeHerdrAdapter({ workMs: 200 })
  try {
    const out = await adapter.openExecution({ name: "归档我", prompt: "x" })
    assert.equal((await adapter.archive("归档我")).ok, true)
    await assert.rejects(adapter.status("归档我"), /账本里没有会话/)
    await assert.rejects(adapter.status(out.convId), /账本里没有会话/)
    assert.equal((await adapter.archive("归档我")).ok, true, "幂等")
    assert.deepEqual(await adapter.runningMap(), {})
  } finally {
    cleanup()
  }
})

test("herdr 未知目标与旧账本条目：报缺失；无 paneId 的旧条目 info 可读", async () => {
  const { adapter, cleanup, dir } = makeHerdrAdapter()
  try {
    await assert.rejects(adapter.status("从没派过"), /账本里没有会话/)
    // 旧账本条目（无 paneId）在 herdr 驱动下不可续说，但 info/status 可读
    const legacyFile = path.join(dir, "zcode-sessions.json")
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, sessions: { legacy: { key: "legacy", name: "legacy", sessionId: "sess_old", convId: "sess_old", status: "done", lastReply: "旧回复" } }, aliases: { legacy: "legacy" } }))
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, sessions: { legacy: { key: "legacy", name: "legacy", sessionId: "sess_old", convId: "sess_old", status: "done", lastReply: "旧回复" } }, aliases: { legacy: "legacy" } }))
    const legacy = new ZcodeSessionAdapter({
      cfg: {
        stateFile: path.join(dir, "state.json"),
        zcode: { ledger: legacyFile },
        herdr: { bin: `node ${HERDR_FAKE}` },
      },
      log: () => {},
    })
    const info = await legacy.info("legacy")
    assert.equal(info.running, false)
    assert.match(info.lastReply, /旧回复/)
  } finally {
    cleanup()
  }
})

test("配置：agent 只认 noop/dws/zcode，默认 noop，写错兜底 noop；zcode 段默认齐", () => {
  assert.equal(loadConfig(tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "sit" }] })).agent, "noop")
  assert.equal(loadConfig(tmpConfig({ agent: "zcode" })).agent, "zcode")
  assert.equal(loadConfig(tmpConfig({ agent: "dws" })).agent, "dws")
  assert.equal(loadConfig(tmpConfig({ agent: "noop" })).agent, "noop")
  assert.equal(loadConfig(tmpConfig({ agent: "豆包" })).agent, "noop")
  const cfg = loadConfig(tmpConfig({ agent: "zcode" }))
  assert.deepEqual(cfg.zcode, { bin: "", ledger: "", tuiBin: "" })
})
