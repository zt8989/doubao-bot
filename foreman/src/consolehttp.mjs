// 控制台 HTTP：由常驻服务直接对外提供页面与 API，不另起进程、不走 socket。
//   GET  /                 控制台页面
//   GET  /style.css /app.js 静态资源
//   GET  /api/snapshot     当天任务 + PR + 统计（每次请求都先跟账本对齐）
//   GET  /api/polls        最近几轮扫描记录
//   POST /api/sync         立刻扫一轮 PR（opencli）+ 落库，返回最新快照
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { Book } from "./book.mjs"

const MAX_BODY = 1 << 20

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

const sendJson = (res, code, body) => {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

function serveStatic(res, dir, name) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("not found")
  }
  const buf = fs.readFileSync(file)
  res.writeHead(200, { "content-type": MIME[path.extname(name)] || "application/octet-stream", "cache-control": "no-cache" })
  res.end(buf)
}

/**
 * 起 HTTP 监听（同时承担 CLI 的 RPC 通道与控制台页面）。
 * port 传 0 由系统分配；被占用时抛 code=EADDRINUSE，交给调用方处理。
 * onRpc：CLI 请求分发（service.mjs 的 handleRequest）。
 */
export function startConsoleHttp({ store, ctx, dir, host = "127.0.0.1", port = 7317, log = () => {}, onRpc = null }) {
  const startedAt = Date.now()

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let buf = ""
      req.on("data", (d) => {
        buf += d
        if (buf.length > MAX_BODY) {
          reject(Object.assign(new Error("请求体过大"), { code: "too_large" }))
          req.destroy()
        }
      })
      req.on("end", () => {
        if (!buf.trim()) return resolve({})
        try {
          resolve(JSON.parse(buf))
        } catch (e) {
          reject(Object.assign(e, { code: "bad_json" }))
        }
      })
      req.on("error", reject)
    })

  const snapshotNow = () => {
    const book = new Book(ctx.cfg.stateFile)
    const sync = store.sync(book)
    return store.snapshot({
      book,
      cfg: ctx.cfg,
      pr: { ...ctx.state.pr, lastNewPrs: sync.newPrs },
      service: {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        socket: ctx.cfg.service?.socket ?? "",
        http: ctx.httpUrl ?? "",
      },
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`)
    const pathname = decodeURIComponent(url.pathname)

    try {
      if (pathname === "/api/ping") {
        const r = onRpc ? await onRpc({ id: "ping", cmd: "ping" }) : { ok: true, pid: process.pid }
        return sendJson(res, 200, r)
      }

      if (pathname === "/api/rpc") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (!onRpc) return sendJson(res, 501, { ok: false, error: "rpc_not_enabled" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const r = await onRpc(body)
        return sendJson(res, 200, r)
      }

      if (pathname === "/api/snapshot") {
        return sendJson(res, 200, snapshotNow())
      }

      if (pathname === "/api/polls") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50)
        return sendJson(res, 200, { ok: true, polls: store.polls(limit) })
      }

      if (pathname === "/api/sync") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        const r = await ctx.prPoll()
        return sendJson(res, r?.ok === false ? 500 : 200, { ok: r?.ok !== false, sync: r, snapshot: snapshotNow() })
      }

      if (pathname === "/" || pathname === "/index.html") return serveStatic(res, dir, "index.html")
      if (pathname === "/style.css") return serveStatic(res, dir, "style.css")
      if (pathname === "/app.js") return serveStatic(res, dir, "app.js")

      return sendJson(res, 404, { ok: false, error: "not_found", path: pathname })
    } catch (e) {
      log(`控制台请求失败 ${pathname}：${e.message}`)
      return sendJson(res, 500, { ok: false, error: "internal_error", message: e.message })
    }
  })

  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      server.removeAllListeners("error")
      server.on("error", (err) => log(`控制台 HTTP 异常：${err.message}`))
      reject(e)
    })
    server.listen(port, host, () => {
      server.removeAllListeners("error")
      server.on("error", (err) => log(`控制台 HTTP 异常：${err.message}`))
      const actual = server.address()?.port ?? port
      resolve({ server, port: actual, url: `http://${host}:${actual}` })
    })
  })
}
