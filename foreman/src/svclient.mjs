// 服务客户端：全部走 HTTP。端口从端口文件里读（服务启动时写），CLI 不碰 socket。
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

export class ServiceError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.code = "service_unavailable"
    Object.assign(this, extra)
  }
}

// 端口文件：纯数字一行；兼容早期写成 {"port":N} 的 JSON。
export function readPortFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim()
    if (!raw) return 0
    if (raw.startsWith("{")) return Number(JSON.parse(raw).port) || 0
    return Number(raw) || 0
  } catch {
    return 0
  }
}

export function portFileOf(cfg) {
  return path.resolve(String(cfg?.service?.http?.portFile || "~/.foreman/service.port").replace(/^~/, process.env.HOME || ""))
}

// 解析端口：优先端口文件（服务实际在听的），退回配置里的端口。
export function resolvePort(cfg) {
  return readPortFile(portFileOf(cfg)) || Number(cfg?.service?.http?.port) || 0
}

// 客户端连哪个地址：监听 0.0.0.0 / :: 时走回环，否则就用配置里的 host（本机同样能连通）。
export function connectHost(host) {
  const h = String(host ?? "").trim()
  if (!h || h === "0.0.0.0" || h === "::" || h === "[::]") return "127.0.0.1"
  return h
}

// 一次解析出 host + port，避免各处各自拼。
export function resolveTarget(cfg) {
  return { host: connectHost(cfg?.service?.http?.host), port: resolvePort(cfg) }
}

function httpJson(host, port, method, reqPath, body, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8")
    const req = http.request(
      {
        host,
        port,
        path: reqPath,
        method,
        headers: payload
          ? { "content-type": "application/json; charset=utf-8", "content-length": payload.length }
          : {},
      },
      (res) => {
        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (d) => (buf += d))
        res.on("end", () => {
          let obj
          try {
            obj = JSON.parse(buf)
          } catch {
            return reject(
              Object.assign(new Error(`服务响应不是 JSON：${buf.slice(0, 120) || "(空)"}`), { code: "bad_response" })
            )
          }
          if (obj?.ok === false) {
            return reject(Object.assign(new Error(obj.message || obj.error || "服务返回失败"), { code: obj.error, raw: obj }))
          }
          resolve(obj)
        })
      }
    )
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`连接超时（${timeoutMs}ms）`), { code: "timeout" }))
    }, timeoutMs)
    req.on("close", () => clearTimeout(timer))
    req.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    if (payload) req.write(payload)
    req.end()
  })
}

// 通用调用：POST /api/rpc。target 可以是 {host, port}、端口号、端口文件路径、或 "http://host:port"。
export async function callRaw(target, req, timeoutMs = 3000) {
  const { host, port } = hostPortOfTarget(target)
  return httpJson(host, port, "POST", "/api/rpc", req, timeoutMs)
}

// 兼容老的「只给端口」调用：没给 host 就按回环连。
function hostPortOfTarget(target) {
  if (target && typeof target === "object") {
    return { host: connectHost(target.host), port: Number(target.port) || 0 }
  }
  if (typeof target === "string" && target.trim().startsWith("http")) {
    const u = new URL(target.trim())
    return { host: connectHost(u.hostname), port: Number(u.port) || 80 }
  }
  return { host: "127.0.0.1", port: portOfTarget(target) }
}

function portOfTarget(target) {
  if (typeof target === "number") return target
  const s = String(target ?? "").trim()
  if (/^\d+$/.test(s)) return Number(s)
  if (s.startsWith("http")) {
    try {
      return Number(new URL(s).port) || 80
    } catch {
      return 0
    }
  }
  const p = readPortFile(s)
  if (p) return p
  throw Object.assign(new Error(`端口来源不认识：${s}`), { code: "bad_target" })
}

// 短超时 ping：服务在不在。
export async function pingOnce(target, timeoutMs = 200) {
  const { host, port } = hostPortOfTarget(target)
  return httpJson(host, port, "GET", "/api/ping", null, timeoutMs)
}

// 默认后台拉起：detach 一个 `node bin/foreman.mjs serve -c <cfgPath>`，stdout/stderr 接到 service.log。
function defaultSpawn(cfg) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bin = path.resolve(here, "..", "bin", "foreman.mjs")
  fs.mkdirSync(path.dirname(cfg.service.logFile), { recursive: true })
  const fd = fs.openSync(cfg.service.logFile, "a")
  const args = [process.execPath, bin, "serve"]
  if (cfg.configPath) args.push("-c", cfg.configPath)
  const child = spawn(args[0], args.slice(1), {
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  child.unref()
  return child
}

// 握手：端口文件有端口且 ping 通 → 直接用；否则 spawn 后台 serve，轮询端口文件直到 ping 通。
// --no-service / cfg.service.enabled===false → 不 ping 不 spawn，返回 {ok:false, skipped:"no-service"}。
export async function ensureService({ cfg, log = () => {}, noService = false, spawnFn = null }) {
  if (noService || cfg?.service?.enabled === false) {
    return { ok: false, skipped: "no-service" }
  }
  const portFile = portFileOf(cfg)

  const port0 = readPortFile(portFile) || Number(cfg?.service?.http?.port) || 0
  if (port0) {
    try {
      const r = await pingOnce(port0, 200)
      return { ok: true, started: false, port: port0, info: r }
    } catch {}
  }

  const spawn = spawnFn ?? defaultSpawn
  let child
  try {
    child = spawn(cfg)
  } catch (e) {
    throw new ServiceError(`后台拉起服务失败：${e.message}`, { cause: e })
  }

  const deadline = Date.now() + (cfg.service.handshakeTimeoutMs ?? 5000)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    const port = readPortFile(portFile)
    if (!port) continue
    try {
      const r = await pingOnce(port, 250)
      log(`服务已起：pid=${child?.pid ?? "?"} port=${port}`)
      return { ok: true, started: true, pid: child?.pid, port, info: r }
    } catch {}
  }
  throw new ServiceError("服务在超时内没握手成功", {
    logFile: cfg.service.logFile,
    portFile,
  })
}
