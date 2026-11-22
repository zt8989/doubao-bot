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

// processes 列出正在跑这个二进制的进程（pid + 命令行）。
// 发现“用户自己开的那个”和 `dws start --force` 该杀谁，都靠它：只认主进程，
// 不碰 Chromium 的 Helper 子进程（主进程退了，子进程跟着退）。
// Windows 没有 ps：走 PowerShell CIM（wmic 在新系统已移除，命令行经 -EncodedCommand
// 传入，避开引号转义）；POSIX 仍用 ps -axww。
export function processes(binary) {
  const rows = process.platform === "win32" ? processesWin(binary) : processesPs(binary)
  return rows.filter((p) => commandMatchesBinary(p.command, binary))
}

function processesPs(binary) {
  let out = ""
  try {
    out = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return []
  }
  const list = []
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    list.push({ pid: Number(m[1]), command: m[2] })
  }
  return list
}

function processesWin(binary) {
  const name = path.win32.basename(binary).replaceAll("'", "''") // WQL 转义单引号
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ` +
    `Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
  let out = ""
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
      windowsHide: true,
    })
  } catch {
    return []
  }
  let rows
  try {
    rows = JSON.parse(out || "null")
  } catch {
    return []
  }
  if (!rows) return []
  return (Array.isArray(rows) ? rows : [rows])
    .filter((r) => Number.isInteger(r?.ProcessId) && typeof r?.CommandLine === "string")
    .map((r) => ({ pid: r.ProcessId, command: r.CommandLine }))
}

// commandMatchesBinary 判断一条命令行是不是在跑这个二进制。
// Windows 的 CommandLine 里 exe 常带引号（"C:\…\Doubao.exe" args…），且盘符、
// 分隔符、大小写都可能不同：比较前统一剥引号、归一斜杠、转小写。
export function commandMatchesBinary(command, binary, platform = process.platform) {
  if (platform !== "win32") return command === binary || command.startsWith(binary + " ")
  const norm = (s) => s.replaceAll('"', "").replaceAll("\\", "/").toLowerCase()
  const c = norm(command)
  const b = norm(binary)
  return c === b || c.startsWith(b + " ")
}

// copies 只留命令行（老接口，别删：App 的 others 注入还按它来）。
export function copies(binary) {
  return processes(binary).map((p) => p.command)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM 说明进程还在，只是不归我们发信号
    return e?.code === "EPERM"
  }
}

// signalPids 给一批 pid 发信号；已经退掉的、没权限的都跳过，不抛错。
export function signalPids(pids, sig) {
  for (const pid of pids) {
    try {
      process.kill(pid, sig)
    } catch {}
  }
}

// killPids 按「先 SIGTERM 让它体面退出、等一会儿还活着再 SIGKILL」杀一批进程。
// 返回 { term, kill, stillAlive }：term = 发了 SIGTERM 的，kill = 补了 SIGKILL 的。
export async function killPids(pids, { graceMs = 5000, pollMs = 250, signal } = {}) {
  const list = (pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0)
  if (!list.length) return { term: [], kill: [], stillAlive: [] }
  signalPids(list, "SIGTERM")
  const until = Date.now() + graceMs
  while (Date.now() < until && list.some(alive)) await sleep(pollMs, signal)
  const stubborn = list.filter(alive)
  if (stubborn.length) signalPids(stubborn, "SIGKILL")
  const hardUntil = Date.now() + 2000
  while (Date.now() < hardUntil && stubborn.some(alive)) await sleep(pollMs, signal)
  return { term: list, kill: stubborn, stillAlive: list.filter(alive) }
}

export class App {
  constructor({ binary, dataDir, owns, args = [], others, procs, kill = killPids, probe = targets }) {
    Object.assign(this, { binary, dataDir, owns, args, kill, probe })
    this.procs = procs ?? (() => processes(binary))
    this.others = others ?? (() => this.procs().map((p) => p.command))
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
    const list = await this.probe(port)
    return list && this.owns(list) ? port : 0
  }

  // status 把启动现场一次说清：
  //   port    我们自己的实例在后面答 CDP 的端口（0 = 没有）
  //   savedPort 上次落盘的端口（可能已失效）
  //   procs   跑这个二进制的全部进程
  //   foreign 不带我们 profile 的那些 —— 用户自己开的豆包，dws 接管不了
  async status() {
    const savedPort = this.savedPort()
    const list = savedPort ? await this.probe(savedPort) : null
    const port = list && this.owns(list) ? savedPort : 0
    const mine = `--user-data-dir=${this.profile}`
    const procs = this.procs()
    return { port, savedPort, procs, foreign: procs.filter((p) => !p.command.includes(mine)) }
  }

  // shutdown 杀掉这个二进制的全部进程（只给 `dws start --force` 清场用）。
  // 用户自己开的豆包窗口会一起没，这是 --force 明确要求的行为；杀掉后把失效的端口文件清掉。
  async shutdown({ graceMs = 5000, signal } = {}) {
    const procs = this.procs()
    if (!procs.length) {
      try {
        fs.rmSync(this.portFile, { force: true })
      } catch {}
      return { pids: [], term: [], kill: [] }
    }
    const pids = procs.map((p) => p.pid)
    const r = await this.kill(pids, { graceMs, signal })
    const until = Date.now() + 3000
    while (Date.now() < until && this.procs().length) await sleep(250, signal)
    if (this.procs().length) {
      throw Object.assign(Error(`豆包进程杀不掉（PID ${this.procs().map((p) => p.pid).join(", ")}）`), {
        code: "app_kill_failed",
      })
    }
    try {
      fs.rmSync(this.portFile, { force: true })
    } catch {}
    return { pids, term: r.term ?? pids, kill: r.kill ?? [] }
  }

  // up 独占启动：已由 dws 起好且端口在答就直接复用；豆包在跑但没开 CDP 时
  // 没有 force 就报 app_busy（并提示 --force），有 force 就先杀掉再起。
  // 返回 { port, already, killed }——killed 是本次被 --force 杀掉的 pid。
  async up({ timeout = 45000, force = false, signal } = {}) {
    const st = await this.status()
    if (st.port) return { port: st.port, already: true, killed: [] }
    if (!fs.existsSync(this.binary)) {
      throw Object.assign(Error(`找不到豆包：${this.binary}`), { code: "app_missing" })
    }
    let killed = []
    if (st.procs.length) {
      const pids = st.procs.map((p) => p.pid).join(", ")
      if (!force) {
        throw Object.assign(
          Error(
            `豆包已经在运行（PID ${pids}），但没有可用的 CDP 调试端口，dws 接管不了。\n` +
              `  要独占启动就加 --force：dws start --force（会先杀掉豆包进程再启动）\n` +
              `  或者自己退出豆包后重跑`
          ),
          { code: "app_busy", pids: st.procs.map((p) => p.pid) }
        )
      }
      // --force：清场。同一个二进制只能有一个实例，我们自己那份没开端口的残留也一起杀。
      const shut = await this.shutdown({ signal })
      killed = shut.pids
    }
    const port = await this.launch({ timeout, signal })
    return { port, already: false, killed }
  }

  // start 没启动就启动，等到页面应答为止；从不杀进程（要杀用 up({ force: true })）。
  // 用户自己开着的那份会把新进程“抢走”后自己退出（macOS 单实例），
  // 且默认 profile 不允许开调试端口，所以这种情况直接报 app_busy。
  async start(opts = {}) {
    return (await this.up(opts)).port
  }

  // launch 真的拉起进程并等页面应答；清场逻辑不在这里。
  async launch({ timeout = 45000, signal } = {}) {
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
      const list = await this.probe(port)
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
