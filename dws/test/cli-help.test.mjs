// 子命令 --help/-h 的回归：只打用法，绝不进入执行流程。
// 这里用子进程跑真实 CLI，并检查运行目录没被写出任何状态文件。
import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BIN = path.join(ROOT, "bin", "dws.mjs")

function run(args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dws-help-"))
  const env = { ...process.env, HOME: cwd, DOUBAO_WORK_HOME: path.join(cwd, "profile") }
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", timeout: 15000, env })
  const files = fs.readdirSync(cwd)
  fs.rmSync(cwd, { recursive: true, force: true })
  return { ...r, files }
}

const CASES = [
  { args: ["start", "--help"], expect: "dws start", label: "start --help" },
  { args: ["open", "--help"], expect: "dws open --name", label: "open --help" },
  { args: ["send", "--help"], expect: "handoff", label: "send --help" },
  { args: ["status", "--help"], expect: "dws status", label: "status --help" },
  { args: ["doctor", "-h"], expect: "dws doctor", label: "doctor -h" },
]

for (const c of CASES) {
  test(`${c.label} 只打用法，不执行`, () => {
    const r = run(c.args)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^用法：/)
    assert.equal(r.stdout.includes(c.expect), true, r.stdout)
    assert.equal(r.stderr, "")
    assert.deepEqual(r.files, [], "帮助不该在运行目录留下任何文件（state/worktree 等）")
  })
}

test("帮助优先于其它参数：open --name x --help 不发消息、不建任务", () => {
  const r = run(["open", "--name", "smoke", "--help"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^用法：/)
  assert.equal(r.stdout.includes("dws open --name"), true)
  assert.deepEqual(r.files, [])
})

test("顶层 dws --help 仍列出全部命令", () => {
  const r = run(["--help"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /dws \d+\.\d+\.\d+ —— 豆包会话 CLI/)
  assert.equal(r.stdout.includes("dws help <命令>"), true)
  assert.deepEqual(r.files, [])
})

// dws 只管豆包会话：工单/PR/编排那几条命令必须真的没了，不能被重新加回来。
test("已下线的命令不再可用", () => {
  for (const cmd of ["run", "retry", "tasks"]) {
    const r = run([cmd])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /未知命令/)
    assert.deepEqual(r.files, [])
  }
})


// doctor --start 已下线：它和 dws start 重复（都是拉起窗口 + 查登录态），
// 调用要明确报错并指向 dws start，不能静默跳过登录态检查。
test("dws doctor --start 已下线，报错并指向 dws start", () => {
  const r = run(["doctor", "--start"])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /--start.*已下线|已下线.*--start/)
  assert.match(r.stderr, /dws start/)
  assert.deepEqual(r.files, [])
})

// `-c <文件>` 曾被当成布尔，值漏成位置参数，报 p.startsWith is not a function。
test("-c 短参与 --config 等价", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dws-c-"))
  const cfgFile = path.join(cwd, "my.json")
  fs.writeFileSync(cfgFile, JSON.stringify({ stateFile: "state.json", pollSeconds: 4 }))
  const env = { ...process.env, HOME: cwd, DOUBAO_WORK_HOME: path.join(cwd, "profile") }
  const short = spawnSync(process.execPath, [BIN, "doctor", "-c", cfgFile], { cwd, encoding: "utf8", timeout: 15000, env })
  const long = spawnSync(process.execPath, [BIN, "doctor", "--config", cfgFile], { cwd, encoding: "utf8", timeout: 15000, env })
  fs.rmSync(cwd, { recursive: true, force: true })
  for (const [label, r] of [["-c", short], ["--config", long]]) {
    assert.ok(!String(r.stderr).includes("startsWith"), `${label} 报了解析错误：${r.stderr}`)
    assert.ok(r.stdout.includes(cfgFile), `${label} 没读到指定配置：${r.stdout}`)
  }
})
