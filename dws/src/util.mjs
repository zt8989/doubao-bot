// 公共工具：子进程、PATH、JSON 落盘、参数解析、日志。
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// 非登录 shell 里 opencli / agently-cli / pnpm 常常不在 PATH 里：
// 统一把几个已知目录补在最前面。
export const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), ".nvm/versions/node/v22.21.1/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".local/bin"),
]

export function envWithBins(extra = {}) {
  const dirs = [...EXTRA_BIN_DIRS]
  const seen = new Set()
  const rest = (process.env.PATH ?? "").split(":").filter((d) => d && !seen.has(d))
  for (const d of rest) {
    if (!dirs.includes(d)) dirs.push(d)
  }
  return { ...process.env, PATH: dirs.join(":"), ...extra }
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? Error("aborted"))
    const stop = () => {
      clearTimeout(t)
      reject(signal.reason ?? Error("aborted"))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }, ms)
    signal?.addEventListener("abort", stop, { once: true })
  })

export function expandHome(p) {
  if (!p) return p
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

// exec 跑一个子进程，收 stdout/stderr；非 0 退出抛错，错误上带 stdout/stderr/code。
export function exec(cmd, args = [], { cwd, timeout = 120000, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? envWithBins(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5000).unref?.()
    }, timeout)
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(Object.assign(e, { code: e.code ?? "spawn_error" }))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) return resolve({ stdout, stderr, code })
      const err = Error(
        `${cmd} ${args.join(" ")} 退出码 ${code}${timedOut ? "（超时）" : ""}\n${(stderr || stdout).trim().slice(-4000)}`
      )
      Object.assign(err, { code, stdout, stderr, timedOut })
      reject(err)
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

// extractJson 从带噪声的输出里切出第一段完整 JSON
// （opencli 末尾会带 “Update available …”，直接 JSON.parse 会炸）。
export function extractJson(raw) {
  const s = String(raw)
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start < 0 || end < start) throw Error(`输出里没有 JSON：${s.trim().slice(0, 400)}`)
  return JSON.parse(s.slice(start, end + 1))
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  fs.renameSync(tmp, file)
}

export function nowIso() {
  return new Date().toISOString()
}

// parseArgs: `--k v`、`--k=v`、布尔旗标、位置参数；`--` 之后全算位置参数。
export function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      pos.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const k = a.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          flags[k] = next
          i++
        } else {
          flags[k] = true
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true
    } else {
      pos.push(a)
    }
  }
  return { pos, flags }
}

// 人看的进度/提示一律走 stderr，stdout 只留结构化结果，方便 `| jq`。
export function log(...parts) {
  process.stderr.write(parts.join(" ") + "\n")
}

export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n")
}

export function isTruthy(v, fallback = false) {
  if (v === undefined || v === null) return fallback
  if (v === true) return true
  if (v === false) return false
  return !["0", "false", "no", "off", ""].includes(String(v).toLowerCase())
}

export function slugify(text, max = 32) {
  const ascii = String(text ?? "")
    .replace(/[（(].*?[）)]/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return ascii ? ascii.slice(0, max).replace(/-+$/g, "") : ""
}

// selfConvIds 从环境里认出「发出这条命令的会话自己」。
// 在豆包侧边栏里让 agent 跑 dws 时，MCP_VM_CONVERSATION_ID 就是当前会话 id；
// 终端里手跑通常没有这些变量，返回空数组（此时不做自我保护）。
export function selfConvIds(env = process.env) {
  return [env.DWS_SELF_CONV_ID, env.MCP_VM_CONVERSATION_ID, env.DOUBAO_CONVERSATION_ID]
    .map((x) => String(x ?? "").trim())
    .filter((x) => /^\d{8,}$/.test(x))
}

// isFreshTask 判定「点完新建工作任务之后，窗口是不是真的离开了旧会话」。
// 这是记账层的守卫（不是浏览器侧 NEW_TASK 的成功判据）：必须知道新建前在哪个会话，
// 并且新建后拿到的 id 与它不同，否则就是没切过去，提示词发进旧会话了。
//   beforeConvId: 点之前 location.href 里解析出的会话 id
//   afterConvId:  点之后（或发完首条消息回读时）location.href 里的会话 id
//   requireNewId: true 时 afterConvId 必须是具体数字 id（发完首条消息回读用）；
//                 false 时 afterConvId 为空也接受（刚点完停在 /chat 新页、还没发消息）。
export function isFreshTask(beforeConvId, afterConvId, { requireNewId = false } = {}) {
  const before = String(beforeConvId ?? "").trim()
  const after = String(afterConvId ?? "").trim()
  if (!/^\d{8,}$/.test(before)) return false // 不知道从哪个会话点的，无法判定
  if (before === after) return false // 根本没离开旧会话
  if (requireNewId && !/^\d{8,}$/.test(after)) return false // 期望拿到具体新 id 却没拿到
  return true
}
