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

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// exec：统一的子进程出口。超时用 SIGKILL，错误里带上 stdout/stderr 片段，
// 免得调用方只看 exit code 猜原因。
export function exec(cmd, args, { cwd, timeout = 60000, input, env } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
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

export function commandExists(cmd) {
  const dirs = (process.env.PATH ?? "").split(":")
  return dirs.some((d) => {
    try {
      return fs.existsSync(path.join(d, cmd)) && fs.statSync(path.join(d, cmd)).isFile()
    } catch {
      return false
    }
  })
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const body = a.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      const key = shortMap[a.slice(1)]
      if (key) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next
          i++
        } else flags[key] = true
      } else {
        flags[a.slice(1)] = true
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
