// zcode 驱动层：foreman 不碰 ZCode 内部实现，一律通过 zcode CLI 的 headless 模式把活儿派出去。
// zcode -p "<prompt>" --json 阻塞跑完一轮并返回 { sessionId, response }；--resume <sessId> 续说且带完整上下文。
// 与 dws 的差别：没有单实例桌面窗口（可并行多张单），首轮是阻塞调用——跑完才返回。
// prompt 一律走 argv（实测 -p 不读 stdin）；超长（>90KB，Linux 单参数 128KB 上限）写临时文件走 --attach。
// 会话账本 zcode-sessions.json：名字 / 伪 id / sess id 三方互查，服务重启后 watch 轮询仍能解析旧会话。
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { exec, expandHome, extractJson, sleep } from "./util.mjs"

export class ZcodeError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, { code: "zcode_error" }, extra)
  }
}

// mac 上桌面版自带的 CLI：`zcode` 不在 PATH 时兜底（用当前 node 跑）。
const ZCODE_BUNDLE_CJS = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
// argv 单参数的保守上限：Linux MAX_ARG_STRLEN 是 128KB，留出余量。
const ARGV_PROMPT_MAX = 90 * 1024

function isScriptPath(p) {
  return /\.(cjs|mjs|js)$/i.test(String(p ?? ""))
}

// 会话账本默认路径：stateFile 同目录（CLI 的 foreman sessions 与适配器共用同一推导）。
export function defaultLedgerPath(cfg = {}) {
  const stateFile = expandHome(String(cfg?.stateFile ?? "state.json"))
  return path.join(path.dirname(path.resolve(stateFile)), "zcode-sessions.json")
}

// bin 解析：显式配置（可为带空格的一条命令，如 `node /path/fake.cjs`）→ PATH 上的 zcode → 桌面版内置 cjs。
export function resolveZcodeCommand(binCfg = "", { platform = process.platform, execPath = process.execPath, exists = (p) => fs.existsSync(p) } = {}) {  const raw = String(binCfg ?? "").trim()
  if (raw) {
    const parts = raw.split(/\s+/)
    if (parts.length > 1) return { cmd: parts[0], baseArgs: parts.slice(1) }
    if (isScriptPath(raw)) return { cmd: execPath, baseArgs: [raw] }
    return { cmd: raw, baseArgs: [] }
  }
  // PATH 探测：darwin/linux 找可执行文件；找不到再兜底桌面版。
  const dirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const names = platform === "win32" ? ["zcode.exe", "zcode.cmd", "zcode"] : ["zcode"]
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        if (exists(p)) return { cmd: p, baseArgs: [] }
      } catch {}
    }
  }
  if (platform === "darwin" && exists(ZCODE_BUNDLE_CJS)) return { cmd: execPath, baseArgs: [ZCODE_BUNDLE_CJS] }
  // 都没有也别炸构造：让 run() 报 bin_missing，doctor 能透出可读原因。
  return { cmd: "zcode", baseArgs: [] }
}

function classify(text) {
  const s = String(text ?? "")
  if (/not logged in|登录|login required|unauthorized|401|invalid api key/i.test(s)) return "zcode_auth"
  if (/ENOENT|command not found|not found/i.test(s)) return "bin_missing"
  if (/超时|timeout/i.test(s)) return "zcode_timeout"
  return ""
}

const ERRORS = {
  bin_missing: "找不到 zcode 可执行文件（可配 zcode.bin 指到 zcode 或 ZCode.app 内的 zcode.cjs）",
  zcode_auth: "zcode 没有登录或凭证失效（终端里跑一次 zcode login）",
  zcode_timeout: "zcode 这一轮跑超时了",
}

export class ZcodeDriver {
  constructor({ bin = "", mode = "", ledger = "", log = () => {} } = {}) {
    this.#cmd = resolveZcodeCommand(bin)
    this.mode = String(mode ?? "").trim()
    this.log = log
    this.ledgerFile = ledger
    this.ledger = { version: 1, sessions: {}, aliases: {} }
    if (ledger && fs.existsSync(ledger)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(ledger, "utf8"))
        if (parsed && typeof parsed === "object") {
          this.ledger = { version: 1, sessions: parsed.sessions ?? {}, aliases: parsed.aliases ?? {} }
        }
      } catch (e) {
        this.log(`zcode 账本读不回（当新账本用）：${e.message}`)
      }
    }
    // 活着的后台子进程：key → child，stop/runningMap 用。
    this.children = new Map()
    // 阻塞跑首轮/续跑中的会话（不在 children 里，但并发轮询得看得到它在跑）。
    this.blocking = new Set()
    // 每会话一条执行链：同一会话的多轮严格串行（上一轮没跑完时 steer/notify 排队，
    // 等价 dws msg --mode queue 的「排到当前轮次之后」——不带上下文的并行 --resume 会开成新会话）。
    this.chains = new Map()
    this.seq = 0
  }

  #cmd

  // fn 返回的 promise 进链；链本身吞错（前一轮失败不毒化下一轮）。
  #enqueue(key, fn) {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(key, next.catch(() => {}))
    return next
  }

  // ---- 账本 ----
  #save() {
    if (!this.ledgerFile) return
    const tmp = `${this.ledgerFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.ledger))
    fs.renameSync(tmp, this.ledgerFile)
  }

  #put(entry, aliases = []) {
    for (const a of [entry.key, entry.name, entry.sessionId, ...aliases]) {
      const k = String(a ?? "").trim()
      if (k) this.ledger.aliases[k] = entry.key
    }
    this.ledger.sessions[entry.key] = entry
    this.#save()
  }

  // 纯查：名字 / 伪 id / sess id 任一别名。查不到就是查不到，读路径（status/info）照实报缺失。
  resolve(target) {
    const t = String(target ?? "").trim()
    if (!t) return null
    const key = this.ledger.aliases[t]
    return key ? this.ledger.sessions[key] ?? null : null
  }

  // 续说兜底：账本里没有但长得像 zcode 会话 id（sess_*）的，就地建档继续用——
  // 账本丢了也能按 id 续；别的东西（乱传的名字）照样报缺失。
  #targetForResume(target) {
    const entry = this.resolve(target)
    if (entry) return entry
    const t = String(target ?? "").trim()
    if (/^sess_/.test(t)) {
      const made = { key: t, name: t, sessionId: t, convId: t, cwd: "", status: "done", lastReply: "", updatedAt: Date.now() }
      this.#put(made)
      return made
    }
    throw new ZcodeError(`zcode 账本里没有会话：${target}（可能从没派过，或账本被清了）`, { code: "session_missing", target: t })
  }

  #entry(target) {
    const entry = this.resolve(target)
    if (!entry) throw new ZcodeError(`zcode 账本里没有会话：${target}（可能从没派过，或账本被清了）`, { code: "session_missing", target: String(target ?? "") })
    return entry
  }

  #pidAlive(pid) {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return e?.code === "EPERM"
    }
  }

  // running 判定：活子进程在跑、阻塞轮进行中，或进程没了但账本还没来得及收尾（服务重启后的孤儿）。
  #isRunning(entry) {
    if (entry.status !== "running") return false
    if (this.children.has(entry.key) || this.blocking.has(entry.key)) return true
    return this.#pidAlive(entry.pid)
  }

  #finish(entry, { sessionId = "", reply = "", prompt = "", status = "done", error = "" } = {}) {
    entry.status = status
    entry.lastReply = String(reply ?? "")
    entry.error = String(error ?? "")
    entry.updatedAt = Date.now()
    // 每轮对话留痕（user prompt 摘要 + assistant 回复），控制台 Chat 页用——
    // 只留最近 40 轮，防长会话把账本撑爆；prompt 截 500 字符够看出「这轮派了什么」。
    if (!Array.isArray(entry.messages)) entry.messages = []
    if (prompt) {
      entry.messages.push({ role: "user", text: String(prompt).slice(0, 500), at: entry.updatedAt })
    }
    if (reply) {
      entry.messages.push({ role: "assistant", text: String(reply).slice(-4000), at: entry.updatedAt })
    } else if (status === "error" && error) {
      entry.messages.push({ role: "assistant", text: `（这一轮失败：${String(error).slice(0, 300)}）`, at: entry.updatedAt })
    }
    if (entry.messages.length > 80) entry.messages = entry.messages.slice(-80)
    if (sessionId && sessionId !== entry.sessionId) {
      entry.sessionId = sessionId
      this.ledger.aliases[sessionId] = entry.key
    }
    entry.pid = 0
    this.#save()
  }

  // ---- 进程出口 ----
  async run(args, { timeout = 600000 } = {}) {
    try {
      return await exec(this.#cmd.cmd, [...this.#cmd.baseArgs, ...args], { timeout })
    } catch (e) {
      if (e?.code === "ENOENT") throw new ZcodeError(ERRORS.bin_missing, { code: "bin_missing", args })
      const blob = `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`
      const code = e?.code === "timeout" ? "zcode_timeout" : classify(blob)
      throw new ZcodeError(
        ERRORS[code] || `zcode ${(args[0] ?? "").slice(0, 24)} 失败：${(e.stderr || e.stdout || e.message).trim().slice(-1200)}`,
        { code: code || "zcode_error", args }
      )
    }
  }

  async json(args, opts) {
    const r = await this.run(args, opts)
    try {
      return extractJson(r.stdout)
    } catch (e) {
      throw new ZcodeError(`zcode ${(args[0] ?? "").slice(0, 24)} 输出不是 JSON：${r.stdout.slice(-800)}`, { args })
    }
  }

  #writeTemp(text) {
    const p = path.join(os.tmpdir(), `foreman-zcode-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.writeFileSync(p, String(text ?? ""))
    return p
  }

  // prompt 走 argv；超长转 --attach（正文换成一句指路的话）。
  #promptArgs(prompt, scratch = []) {
    const text = String(prompt ?? "")
    if (Buffer.byteLength(text, "utf8") <= ARGV_PROMPT_MAX) return ["-p", text]
    const file = this.#writeTemp(text)
    scratch.push(file)
    return ["-p", "请先完整阅读附件中的指令，然后严格按附件内容执行。", "--attach", file]
  }

  #turnArgs({ prompt, sessionId = "", repo = "" }, scratch = []) {
    const args = [...this.#promptArgs(prompt, scratch), "--json", "--no-color"]
    if (sessionId) args.unshift("--resume", sessionId)
    if (!sessionId && repo) args.push("--cwd", repo)
    if (this.mode) args.push("--mode", this.mode)
    return args
  }

  #cleanup(scratch) {
    for (const f of scratch) {
      try {
        fs.rmSync(f, { force: true })
      } catch {}
    }
  }

  // 阻塞跑一轮：先在账本里记 running（并发轮询能看到），跑完回填结果。
  async #turnBlocking({ entry, prompt, repo = "" }) {
    const scratch = []
    entry.status = "running"
    entry.updatedAt = Date.now()
    this.#put(entry)
    this.blocking.add(entry.key)
    try {
      const args = this.#turnArgs({ prompt, sessionId: entry.sessionId, repo }, scratch)
      const out = await this.json(args, { timeout: 3600000 })
      this.#finish(entry, { sessionId: String(out.sessionId ?? "") || entry.sessionId, reply: String(out.response ?? ""), prompt })
      return out
    } catch (e) {
      this.#finish(entry, { status: "error", error: e.message })
      throw e
    } finally {
      this.blocking.delete(entry.key)
      this.#cleanup(scratch)
    }
  }

  // 后台跑一轮（只确认「派出去」不等跑完）：伪 id 立刻返回，进程退出后回填真 sess id 与回复。
  // 返回的 promise 在子进程退出时落定（执行链靠它串轮次，调用方不必等它）。
  #turnBackground({ entry, prompt, repo = "" }) {
    return new Promise((resolveBg) => {
      const scratch = []
      const args = this.#turnArgs({ prompt, sessionId: entry.sessionId, repo }, scratch)
      const outFile = this.#writeTemp("")
      scratch.push(outFile)
      entry.status = "running"
      entry.updatedAt = Date.now()
      this.#put(entry)
      const { cmd, baseArgs } = this.#cmd
      const fd = fs.openSync(outFile, "w")
      let child
      try {
        child = spawn(cmd, [...baseArgs, ...args], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } })
      } catch (e) {
        fs.closeSync(fd)
        this.#finish(entry, { status: "error", error: e.message })
        this.#cleanup(scratch)
        resolveBg()
        return
      }
      fs.closeSync(fd)
      child.unref()
      entry.pid = child.pid
      this.#put(entry)
      this.children.set(entry.key, child)
      child.on("close", () => {
        this.children.delete(entry.key)
        try {
          const out = extractJson(fs.readFileSync(outFile, "utf8"))
          this.#finish(entry, { sessionId: String(out.sessionId ?? "") || entry.sessionId, reply: String(out.response ?? ""), prompt })
        } catch (e) {
          this.#finish(entry, { status: "error", error: `后台进程退出但没有拿到结果：${e.message}`, prompt })
        }
        this.#cleanup(scratch)
        resolveBg()
      })
    })
  }

  // ---- 派活出口（dwsdrv 同名语义；同一会话内所有轮次经 #enqueue 严格串行）----
  // open：新会话阻塞跑完首轮（老调用面，返回 convId）。
  async open({ name, repo = "", prompt }) {
    const key = String(name ?? "").trim() || `zcode-open-${++this.seq}`
    this.log(`zcode open ${key}（阻塞跑首轮）`)
    const entry = { key, name: key, sessionId: "", convId: key, cwd: String(repo ?? ""), status: "running", lastReply: "", updatedAt: Date.now() }
    const out = await this.#enqueue(key, () => this.#turnBlocking({ entry, prompt, repo }))
    // convId 用真 sess id（阻塞路径拿得到），账本里名字与 sess 互查。
    entry.convId = entry.sessionId || entry.key
    this.#put(entry)
    return { ok: true, convId: entry.convId, name: key, sessionId: entry.sessionId, response: String(out.response ?? "") }
  }

  // openNew：新会话投递首句。noWait（默认）排队后台跑、立刻返回伪 id；否则等同 open。
  async openNew({ name, prompt, noWait = true }) {
    const key = String(name ?? "").trim() || `zcode-new-${++this.seq}`
    if (!noWait) return this.open({ name: key, prompt })
    const slug = key.replace(/\s+/g, "-").slice(0, 60)
    const pseudo = `zcode-${slug}-${++this.seq}`
    this.log(`zcode open ${key}（后台跑首轮，伪 id ${pseudo}）`)
    const entry = { key: pseudo, name: key, sessionId: "", convId: pseudo, cwd: "", status: "running", lastReply: "", updatedAt: Date.now() }
    this.#put(entry, [key])
    // 新会话没有前轮要排队：直接同步 spawn，保证 deliver 返回时 status 立刻可见 running。
    this.#turnBackground({ entry, prompt }).catch(() => {})
    return { ok: true, convId: pseudo, name: key, sessionId: "", background: true }
  }

  // send：往已有会话续说，排队阻塞到这轮跑完（老调用面）。
  async send(name, text) {
    const entry = this.#entry(name)
    this.log(`zcode send ${entry.name}（阻塞续跑）`)
    await this.#enqueue(entry.key, () => this.#turnBlocking({ entry, prompt: text }))
    return { ok: true, convId: entry.convId, name: entry.name, response: entry.lastReply }
  }

  // notify/steer/queue：排到该会话当前轮次之后，再后台续跑——只确认「派出去了」，
  // 不等这轮跑完（与 dws msg --mode queue 的排队语义对齐）。
  #resumeBackground(target, text, label) {
    const entry = this.#targetForResume(target)
    this.log(`zcode ${label} ${entry.name}（排队后台续跑）`)
    this.#enqueue(entry.key, () => this.#turnBackground({ entry, prompt: text }).catch(() => {}))
    return { ok: true, convId: entry.convId, name: entry.name, background: true }
  }

  notify(target, text) {
    return this.#resumeBackground(target, text, "notify")
  }

  steer(target, text) {
    return this.#resumeBackground(target, text, "steer")
  }

  queue(target, text) {
    return this.#resumeBackground(target, text, "queue")
  }

  // ---- 读状态 ----
  async status(target) {
    const entry = this.#entry(target)
    const running = this.#isRunning(entry)
    const reply = String(entry.lastReply ?? "")
    return {
      name: entry.name,
      streaming: running,
      finished: !running,
      chars: reply.length,
      head: reply.slice(0, 200),
      tail: reply.slice(-200),
      status: running ? "running" : entry.status === "error" ? "error" : "finished",
      reply: { finished: !running },
    }
  }

  async info(target) {
    const entry = this.#entry(target)
    // messages 用账本留痕（每轮 user 摘要 + assistant 回复），经契约层 normalizeSessionMessages
    // 归一成 Chat UI 三角色；running 显式给（契约优先消费它，不再靠尾部猜）。
    const messages = Array.isArray(entry.messages)
      ? entry.messages
      : [{ role: "assistant", text: String(entry.lastReply ?? ""), finished: true }]
    return {
      name: entry.name,
      messages,
      running: this.#isRunning(entry),
      lastReply: String(entry.lastReply ?? ""),
      sessionId: entry.sessionId || "",
      status: entry.status,
    }
  }

  // runningMap：账本全量（键用 convId——watch 绑的就是它），不切任何窗口。
  async runningMap() {
    const out = {}
    for (const entry of Object.values(this.ledger.sessions)) {
      const running = this.#isRunning(entry)
      out[entry.convId] = { running, title: entry.name, active: false }
      // 后台投递的会话 watch 绑的是伪 id；两个键都给，调用方按哪个查都行。
      if (entry.sessionId && entry.sessionId !== entry.convId) {
        out[entry.sessionId] = { running, title: entry.name, active: false }
      }
    }
    return out
  }

  // archive：清掉账本条目（zcode CLI 自己留会话历史，不删它的库）。
  async archive(target) {
    const entry = this.resolve(target)
    if (entry) {
      this.stop(entry.key)
      for (const [alias, key] of Object.entries(this.ledger.aliases)) {
        if (key === entry.key) delete this.ledger.aliases[alias]
      }
      delete this.ledger.sessions[entry.key]
      this.#save()
      this.log(`zcode archive ${entry.name}（清账本，CLI 会话历史保留）`)
    }
    return { ok: true }
  }

  // stop：杀还在跑的后台子进程（阻塞轮没法中断，只能等它超时）。
  stop(target) {
    const entry = this.resolve(target)
    const child = entry ? this.children.get(entry.key) : null
    if (!child) return { ok: false, stopped: false }
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      try {
        child.kill("SIGKILL")
      } catch {}
    }
    this.children.delete(entry.key)
    return { ok: true, stopped: true }
  }

  // start：doctor --start 用——解析 bin 并探活，不新建会话。
  async start() {
    const out = await this.run(["version"], { timeout: 60000 })
    return { ok: true, version: String(out.stdout ?? "").trim().split("\n")[0] }
  }

  // waitFinished：后台轮的收尾兜底——盯到 finished 或超时（与 dwsdrv 同名同语义）。
  async waitFinished(name, { timeoutMs, pollMs = 20000, onTick } = {}) {
    const started = Date.now()
    let last = null
    while (Date.now() - started < timeoutMs) {
      last = await this.status(name).catch(() => last)
      onTick?.(last)
      if (last?.reply?.finished) return last
      await sleep(pollMs)
    }
    return last
  }
}
