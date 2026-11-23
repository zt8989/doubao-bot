#!/usr/bin/env node
// zcode 假 bin：zcode-adapter 测试用。按参数吐固定 JSON，不联网。
// - version 子命令：一行纯文本版本号（真实 CLI 的形态）
// - -p <prompt>（可带 --attach <file> / --cwd <dir> / --resume <id> / --mode <m>）：吐 { sessionId, response }
// - env ZCODE_FAKE_DELAY_MS：延迟再回（模拟「还在跑」）；ZCODE_FAKE_FAIL：非零退出并带错误文本
const args = process.argv.slice(2)

const get = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? String(args[i + 1] ?? "") : ""
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (args[0] === "version") {
    process.stdout.write("zcode-fake 1.0\n")
    return
  }
  const fail = process.env.ZCODE_FAKE_FAIL ?? ""
  if (fail) {
    process.stderr.write(fail + "\n")
    process.exit(3)
  }
  await sleep(Number(process.env.ZCODE_FAKE_DELAY_MS ?? 0))
  const attach = get("--attach")
  let prompt = get("-p")
  if (attach) prompt = `[attach]${require("node:fs").readFileSync(attach, "utf8").slice(0, 60)}`
  const resume = get("--resume")
  const sessionId = resume || `sess_fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const cwd = get("--cwd")
  process.stdout.write(
    JSON.stringify({
      sessionId,
      response: `reply(${sessionId.slice(-6)})${prompt ? ":" + prompt.slice(0, 60) : ""}${cwd ? "@cwd:" + cwd : ""}`,
    }) + "\n"
  )
}

main().catch((e) => {
  process.stderr.write(String(e?.message ?? e) + "\n")
  process.exit(1)
})
