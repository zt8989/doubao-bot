import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const BIN = fileURLToPath(new URL("../bin/foreman.mjs", import.meta.url))

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

test("doctor --start 用 dws start 检查窗口和登录，不查询虚构会话", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-doctor-"))
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ version: "test" }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const calls = path.join(dir, "dws-calls.jsonl")
    const fakeDws = path.join(dir, "fake-dws.mjs")
    const fakeHerdr = path.join(dir, "fake-herdr.mjs")
    const config = path.join(dir, "foreman.json")
    fs.writeFileSync(fakeDws, `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
if (args[0] === "--version") {
  console.log("0.1.0")
} else if (args[0] === "start") {
  console.log(JSON.stringify({ ok: true, window: true, signedIn: true }))
} else {
  console.error("不是任务 id，也没找到这个会话")
  process.exit(1)
}
`, { mode: 0o755 })
    fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
console.log("herdr 0.9.3")
`, { mode: 0o755 })
    fs.writeFileSync(config, JSON.stringify({
      service: { enabled: false },
      repos: [],
      mail: { enabled: false },
      dws: { bin: fakeDws },
      herdr: { bin: fakeHerdr },
    }))

    const { port } = server.address()
    const result = await run([BIN, "doctor", "--start", "--config", config], {
      env: {
        ...process.env,
        GITEA_BASE_URL: `http://127.0.0.1:${port}`,
        GITEA_TOKEN: "test-token",
      },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, true)
    assert.deepEqual(
      report.checks.find((check) => check.name === "dws 窗口/登录"),
      { name: "dws 窗口/登录", ok: true, detail: "窗口可用，已登录" },
    )
    const dwsCalls = fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
    assert.deepEqual(dwsCalls, [["--version"], ["start"]])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
