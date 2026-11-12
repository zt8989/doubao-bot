// 控制台 HTTP：由常驻服务直接对外提供页面与 API，不另起进程、不走 socket。
//   GET  /                 控制台页面（Vite 构建产物 console/dist）
//   GET  /assets/<name>    带 hash 的 js/css，长缓存
//   GET  /api/snapshot?day=YYYY-MM-DD  当天（或指定某天）任务 + PR + 统计；看今天时先跟账本对齐
//   GET  /api/polls        最近几轮扫描记录
//   GET  /api/history?days=7&day=YYYY-MM-DD&repo=R&key=<owner>/<repo>#<N>  历史事件（按天分组）
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

function serveStatic(res, dir, name, { immutable = false } = {}) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("not found")
  }
  const buf = fs.readFileSync(file)
  res.writeHead(200, {
    "content-type": MIME[path.extname(name)] || "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  })
  res.end(buf)
}

// 前端还没构建时的兜底页：说清楚该跑什么命令，别只回 404。
function serveBuildHint(res) {
  const text = `<!doctype html><meta charset="utf-8"><title>foreman 控制台未构建</title>
<style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0b0f14;color:#cbd5e1;padding:48px}
pre{background:#111826;padding:12px 16px;border-radius:8px;color:#7dd3fc}</style>
<h2>控制台前端还没有构建</h2>
<p>在 foreman 目录跑一次构建，产物会落到 <code>console/dist</code>，服务直接从本地下发：</p>
<pre>cd ~/Documents/workspace/doubao-bot/foreman &amp;&amp; npm run build:console</pre>
<p>开发时可以用 <code>npm run dev:console</code>（Vite dev server，走 /api 代理到 7317）。</p>`
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(text)
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

  const snapshotNow = (day = "") => {
    const book = new Book(ctx.cfg.stateFile)
    // 回看历史某天不用再扫一遍账本写库；看今天才同步，保持实时。
    const sync = day ? null : store.sync(book)
    return store.snapshot({
      book,
      cfg: ctx.cfg,
      pr: { ...ctx.state.pr, lastNewPrs: sync?.newPrs ?? 0 },
      service: {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        socket: ctx.cfg.service?.socket ?? "",
        http: ctx.httpUrl ?? "",
      },
      day,
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
        return sendJson(res, 200, snapshotNow((url.searchParams.get("day") || "").trim()))
      }

      if (pathname === "/api/polls") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50)
        return sendJson(res, 200, { ok: true, polls: store.polls(limit) })
      }

      if (pathname === "/api/history") {
        const days = Number(url.searchParams.get("days") ?? 7)
        return sendJson(res, 200, {
          ok: true,
          ...store.history({
            days: Number.isFinite(days) ? days : 7,
            repo: (url.searchParams.get("repo") || "").trim(),
            key: (url.searchParams.get("key") || "").trim(),
            day: (url.searchParams.get("day") || "").trim(),
          }),
        })
      }

      if (pathname === "/api/operations") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500)
        return sendJson(res, 200, {
          ok: true,
          operations: store.operations({
            limit,
            status: (url.searchParams.get("status") || "").trim(),
            action: (url.searchParams.get("action") || "").trim(),
          }),
        })
      }

      if (pathname === "/api/schedules") {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, schedules: ctx.schedules?.() ?? [] })
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.applySchedules !== "function") return sendJson(res, 501, { ok: false, error: "schedules_not_supported" })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.code || "bad_request", message: e.message })
        }
        const patch = body?.patch ?? body ?? {}
        try {
          const schedules = ctx.applySchedules(patch)
          return sendJson(res, 200, { ok: true, schedules })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: "bad_patch", message: e.message })
        }
      }

      if (pathname === "/api/pickup") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        if (typeof ctx.pickup !== "function") return sendJson(res, 501, { ok: false, error: "pickup_not_supported" })
        const r = await ctx.pickup()
        return sendJson(res, 200, { ok: r?.ok !== false, pickup: r })
      }

      if (pathname === "/api/sync") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" })
        const r = await ctx.prPoll()
        return sendJson(res, r?.ok === false ? 500 : 200, { ok: r?.ok !== false, sync: r, snapshot: snapshotNow() })
      }

      // 控制台前端：Vite 产物（console/dist，`npm run build:console`）。
      // assets 文件名带 hash → 长缓存；页面本身不缓存。
      if (pathname === "/" || pathname === "/index.html") {
        if (!fs.existsSync(path.join(dir, "index.html"))) return serveBuildHint(res)
        return serveStatic(res, dir, "index.html")
      }
      if (/^\/assets\/[A-Za-z0-9._-]+$/.test(pathname)) {
        return serveStatic(res, dir, pathname.slice(1), { immutable: true })
      }

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
