import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

export function expandHome(p) {
  if (!p) return p
  const s = String(p)
  if (s === "~") return os.homedir()
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2))
  return s
}

export function nowIso() {
  return new Date().toISOString()
}

// 工作时间窗：定时轮询只在配置的星期/时段内跑。
// workHours 缺省 = 不限；offUntil 是临时闭嘴时间点（ISO，含时区最好），到点自动恢复。
export function inWorkHours(cfg, at = new Date()) {
  const w = cfg?.workHours
  if (!w || w.enabled === false) return true
  if (w.offUntil) {
    const until = new Date(w.offUntil).getTime()
    if (Number.isFinite(until) && until > at.getTime()) return false
  }
  const days = (w.days ?? [1, 2, 3, 4, 5]).map(Number)
  const day = at.getDay() === 0 ? 7 : at.getDay() // 1=周一 … 7=周日
  if (!days.includes(day)) return false
  const [sh, sm] = String(w.start ?? "08:30").split(":").map(Number)
  const [eh, em] = String(w.end ?? "18:30").split(":").map(Number)
  const mins = at.getHours() * 60 + at.getMinutes()
  return mins >= sh * 60 + sm && mins < eh * 60 + em
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Windows 的 CreateProcess 不认 shebang、不认 .mjs/.js，也不认裸命令名（npm 垫片是
// .cmd）：按扩展名换起方式——脚本交给 node，垫片走 cmd，其余按 PATH+PATHEXT 解析。
const WIN_PATHEXT = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")

function resolveWinBin(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : cmd
  // 先试 PATHEXT：裸名文件是 npm 给 Git Bash 用的 sh 垫片，CreateProcess 跑不了
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const base = path.join(dir, cmd)
    for (const ext of WIN_PATHEXT) {
      try {
        if (fs.statSync(base + ext).isFile()) return base + ext
      } catch {}
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    try {
      if (fs.statSync(path.join(dir, cmd)).isFile()) return path.join(dir, cmd)
    } catch {}
  }
  return cmd
}

function quoteWinArg(arg) {
  return /[\s"]/.test(arg) ? `"${String(arg).replaceAll('"', '\\"')}"` : String(arg)
}

// 返回 spawn 入参：[命令, args 数组或 null（null 表示命令串 + shell:true）]
function prepareSpawn(cmd, args) {
  if (process.platform !== "win32") return [cmd, args]
  const bin = resolveWinBin(cmd)
  const ext = path.extname(bin).toLowerCase()
  if (ext === ".mjs" || ext === ".js") return [process.execPath, [bin, ...args]]
  if (ext === ".cmd" || ext === ".bat") return [`${quoteWinArg(bin)} ${args.map(quoteWinArg).join(" ")}`, null]
  return [bin, args]
}

// exec：统一的子进程出口。超时用 SIGKILL，错误里带上 stdout/stderr 片段，
// 免得调用方只看 exit code 猜原因。
export function exec(cmd, args, { cwd, timeout = 60000, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const [file, spawnArgs] = prepareSpawn(cmd, args)
    let child
    try {
      child = spawn(file, spawnArgs ?? [], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        ...(spawnArgs === null ? { shell: true } : {}),
      })
    } catch (e) {
      return reject(Object.assign(e, { code: "spawn", cmd, args }))
    }
    let out = ""
    let err = ""
    const timer = timeout
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {}
          reject(
            Object.assign(new Error(`${cmd} 超时（${Math.round(timeout / 1000)}s）`), {
              code: "timeout",
              stdout: out,
              stderr: err,
              args,
            })
          )
        }, timeout)
      : null
    const done = (fn) => {
      if (timer) clearTimeout(timer)
      fn()
    }
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) =>
      done(() => reject(Object.assign(e, { code: e.code ?? "spawn_error", stdout: out, stderr: err, args })))
    )
    child.on("close", (code) =>
      done(() => {
        if (code === 0) return resolve({ stdout: out, stderr: err, code })
        reject(
          Object.assign(new Error(`${cmd} ${args.join(" ")} 退出码 ${code}：${(err || out).trim().slice(-2000)}`), {
            code: "exit",
            stdout: out,
            stderr: err,
            args,
          })
        )
      })
    )
    child.stdin.end(input ?? "")
  })
}

// execShell：跑一段 shell 命令文本（verify 命令这类"一整行"），按平台选 shell。
// Windows 用 cmd.exe（/s 让外层引号被正确剥掉），不依赖 Git Bash；
// POSIX 保留 bash -lc：登录 shell 会补 PATH（nvm/homebrew 都在里面），行为不变。
export function execShell(cmd, { cwd, timeout = 60000, env } = {}) {
  if (process.platform === "win32") {
    return exec("cmd.exe", ["/d", "/s", "/c", cmd], { cwd, timeout, env })
  }
  return exec("bash", ["-lc", cmd], { cwd, timeout, env })
}

export function commandExists(cmd) {
  const exts = process.platform === "win32" ? ["", ...WIN_PATHEXT] : [""]
  const dirs = (process.env.PATH ?? "").split(path.delimiter)
  return dirs.some((d) =>
    exts.some((ext) => {
      const p = path.join(d, cmd + ext)
      try {
        return fs.existsSync(p) && fs.statSync(p).isFile()
      } catch {
        return false
      }
    })
  )
}

// opencli / herdr 常把 “Update available …” 之类的噪声混在 JSON 前后，
// 取首个 { 到末个 } 再解析。
export function extractJson(text) {
  const raw = String(text ?? "")
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`输出里没有 JSON：${raw.slice(-500)}`)
  return JSON.parse(raw.slice(start, end + 1))
}

// parseArgs：--key value / --key=value / 布尔开关；单横线短参只认显式映射，
// 其余一律布尔 true（避免把 -c 的值当成位置参数吞掉）。
export function parseArgs(argv, shortMap = { c: "config" }) {
  const pos = []
  const flags = {}
  const putFlag = (key, value) => {
    if (!Object.hasOwn(flags, key) || flags[key] === true || value === true) {
      flags[key] = value
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value)
    } else {
      flags[key] = [flags[key], value]
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const body = a.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        putFlag(body.slice(0, eq), body.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("-")) {
        putFlag(body, next)
        i++
      } else {
        putFlag(body, true)
      }
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      const key = shortMap[a.slice(1)]
      if (key) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("-")) {
          putFlag(key, next)
          i++
        } else putFlag(key, true)
      } else {
        putFlag(a.slice(1), true)
      }
      continue
    }
    pos.push(a)
  }
  return { pos, flags }
}

export function slugify(s, max = 28) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "")
}

export function truthy(v, dflt = false) {
  if (v === undefined) return dflt
  if (v === true) return true
  if (v === false) return false
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase())
}
