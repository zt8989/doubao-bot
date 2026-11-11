// 一个只做一件事的 Chrome DevTools Protocol 驱动：让 Chromium 系桌面端
// 从自己的 profile 启动，并驱动其中一个页面。
//
// 这段来自 magpie 的 doubao-work 插件（magpie-community/plugins，MIT），
// 为 doubao-bot 做了裁剪：只保留开进程、连页面、eval 三个能力。
import { execFileSync, spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { sleep } from "./util.mjs"

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function getJSON(url, ms = 1500) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw Error(`${url}: HTTP ${r.status}`)
  return r.json()
}

// targets 列出这个端口上的页面；端口没人应答（或不是 DevTools）时给 null。
export async function targets(port) {
  try {
    const list = await getJSON(`http://127.0.0.1:${port}/json/list`)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

// copies 列出正在跑这个二进制的进程命令行，用于发现“用户自己开的那个”。
export function copies(binary) {
  let out = ""
  try {
    out = execFileSync("ps", ["-axww", "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return []
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l === binary || l.startsWith(binary + " "))
}

export class App {
  constructor({ binary, dataDir, owns, args = [], others }) {
    Object.assign(this, { binary, dataDir, owns, args })
    this.others = others ?? (() => copies(binary))
    this.profile = path.join(dataDir, "profile")
    this.portFile = path.join(dataDir, "port")
  }

  savedPort() {
    try {
      const n = Number(fs.readFileSync(this.portFile, "utf8").trim())
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
    } catch {
      return 0
    }
  }

  async running() {
    const port = this.savedPort()
    if (!port) return 0
    const list = await targets(port)
    return list && this.owns(list) ? port : 0
  }

  // start 没启动就启动，等到页面应答为止；从不杀进程。
  // 用户自己开着的那份会把新进程“抢走”后自己退出（macOS 单实例），
  // 且默认 profile 不允许开调试端口，所以这种情况直接报 app_busy。
  async start({ timeout = 45000, signal } = {}) {
    const up = await this.running()
    if (up) return up
    if (!fs.existsSync(this.binary)) {
      throw Object.assign(Error(`找不到豆包：${this.binary}`), { code: "app_missing" })
    }
    const mine = `--user-data-dir=${this.profile}`
    if (this.others().some((c) => !c.includes(mine))) {
      throw Object.assign(
        Error(`豆包正在用你自己的 profile 运行，请先完全退出豆包（⌘Q）再让 dws 启动它`),
        { code: "app_busy" }
      )
    }
    fs.mkdirSync(this.profile, { recursive: true })
    const port = await freePort()
    fs.writeFileSync(this.portFile, String(port))
    const child = nodeSpawn(
      this.binary,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`, ...this.args],
      { detached: true, stdio: "ignore" }
    )
    child.unref?.()
    const until = Date.now() + timeout
    while (Date.now() < until) {
      await sleep(400, signal)
      const list = await targets(port)
      if (list && this.owns(list)) return port
    }
    throw Object.assign(
      Error(`豆包 ${Math.round(timeout / 1000)} 秒内没有开出调试端口`),
      { code: "app_start_timeout" }
    )
  }
}

export class Page {
  static async open(port, pick, { WebSocketImpl = globalThis.WebSocket } = {}) {
    const list = (await targets(port)) ?? []
    const t = list.find((x) => x.type === "page" && pick(x))
    if (!t?.webSocketDebuggerUrl) return null
    const page = new Page(t, WebSocketImpl)
    await page.ready
    return page
  }

  constructor(target, WebSocketImpl) {
    this.target = target
    this.id = 0
    this.pending = new Map()
    this.closed = false
    this.ws = new WebSocketImpl(target.webSocketDebuggerUrl)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(Error("DevTools 连接失败：" + (e?.message ?? "error")))
    })
    this.ws.onmessage = (m) => {
      let d
      try {
        d = JSON.parse(typeof m.data === "string" ? m.data : String(m.data))
      } catch {
        return
      }
      const p = this.pending.get(d.id)
      if (!p) return
      this.pending.delete(d.id)
      if (d.error) p.reject(Error(`${p.method}: ${d.error.message}`))
      else p.resolve(d.result)
    }
    this.ws.onclose = () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(Error("DevTools 连接已关闭"))
      this.pending.clear()
    }
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(Error("DevTools 连接已关闭"))
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const r = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails
      throw Error("page: " + (d.exception?.description ?? d.text ?? "exception").split("\n")[0])
    }
    return r?.result?.value
  }

  async key(key, { code = key, keyCode = 0, text, modifiers = 0 } = {}) {
    await this.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      text,
      modifiers,
    })
    await this.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      text,
      modifiers,
    })
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {}
  }
}
