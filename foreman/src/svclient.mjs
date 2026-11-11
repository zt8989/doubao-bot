// 服务客户端：其它子命令启动时先握手；没起就后台拉起，超时抛 ServiceError。
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { encodeFrame, pingOnce } from "./service.mjs"

export class ServiceError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.code = "service_unavailable"
    Object.assign(this, extra)
  }
}

// 通用调用：发一帧、等一帧响应。
export function callRaw(socketPath, req, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    let buf = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch {}
      reject(Object.assign(new Error(`连接超时（${timeoutMs}ms）`), { code: "timeout" }))
    }, timeoutMs)
    sock.on("connect", () => sock.write(encodeFrame(req)))
    sock.on("data", (d) => {
      buf += d.toString("utf8")
      const idx = buf.indexOf("\n")
      if (idx < 0) return
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const obj = JSON.parse(buf.slice(0, idx))
        if (obj.ok === false) {
          reject(Object.assign(new Error(obj.message || obj.error), { code: obj.error, raw: obj }))
        } else resolve(obj)
      } catch (e) {
        reject(e)
      } finally {
        try { sock.end() } catch {}
      }
    })
    sock.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
  })
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

// 握手：ping 通就直接返回；不通就 spawn 后台 serve，每 200ms ping 至 handshakeTimeoutMs。
// --no-service / cfg.service.enabled===false → 不 ping 不 spawn，返回 {ok:false, skipped:"no-service"}。
export async function ensureService({ cfg, log = () => {}, noService = false, spawnFn = null }) {
  if (noService || cfg?.service?.enabled === false) {
    return { ok: false, skipped: "no-service" }
  }
  const socketPath = cfg.service.socket

  try {
    const r = await pingOnce(socketPath, 200)
    return { ok: true, started: false, info: r }
  } catch {}

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
    try {
      const r = await pingOnce(socketPath, 200)
      log(`服务已起：pid=${child?.pid ?? "?"}`)
      return { ok: true, started: true, pid: child?.pid, info: r }
    } catch {}
  }
  throw new ServiceError("服务在超时内没握手成功", {
    logFile: cfg.service.logFile,
    socket: socketPath,
  })
}
