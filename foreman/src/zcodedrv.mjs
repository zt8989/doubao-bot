// zcode 驱动层：foreman 不碰 ZCode 内部实现，一律把活儿派给 herdr 窗格里常驻的 zcode TUI。
//
// 每个会话 = 一个 herdr workspace（pane 跑 TUI），人可以在 herdr 里围观/插手/批权限；服务重启
// 会话不丢。提交用 `pane run`（原子粘贴文本+回车），状态机（working/idle/blocked/done）来自
// herdr-zcode 插件的 hooks 上报（`pane report-agent`），回复靠 `pane read` 读终端快照。
//
// 已知坑（本机实测，2026-11）：
// - npm 启动器 bin/zcode.js 在 herdr PTY 里会把 TUI 卡死在「正在启动 ZCode…」（裸 runtime
//   正常），所以直接 `node <vendor>/zcode.cjs` 启动；桌面版 cjs 离开自己的目录跑不了，只有
//   npm 包的 vendor cjs 可用。
// - herdr 不注入 HERDR_* 环境变量，得在启动命令里自己带上；TUI 冷启动不带 ZCODE_SESSION_ID
//   会卡在 splash，启动命令里塞一个随机占位 id 即可绕开（runtime 自己生成真 id 落库）。
// - herdr 0.9.5 的检测清单没有 zcode，`agent prompt` 不认 pane（agent_not_ready），所以提交
//   一律走 pane 级命令；agent identity（状态显示/列表）由驱动先手动 report-agent 注册，
//   herdr-zcode 插件随后的上报才接得上（source 必须先持有 pane）。且 TUI 启动期间绝不能对
//   已注册 pane 轮询 agent get——会打断 TUI（splash 卡死），顺序必须是：主屏 → 注册 → 轮询。
//
// prompt 一律走 argv（90KB 上限，Linux 单参数 128KB）；超长写临时文件，正文换成一句指路的
// 话（TUI agent 自己有文件工具，读绝对路径即可）。
// 会话账本 zcode-sessions.json：名字 / 伪 id / convId 三方互查，服务重启后 watch 轮询仍能解
// 析旧会话。convId = paneId（稳定句柄）；sessionId 从 zcode 的 sqlite 尽力回查。
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

// bin 解析：显式配置（可为带空格的一条命令，如 `node /path/fake.cjs`）→ PATH 上的可执行 →
// 兜底裸名（让 run() 报 bin_missing，doctor 能透出可读原因）。
export function resolveCommandOnPath(binCfg = "", names = ["zcode"], { platform = process.platform, execPath = process.execPath, exists = (p) => fs.existsSync(p), pathEnv = process.env.PATH } = {}) {
  const raw = String(binCfg ?? "").trim()
  if (raw) {
    const parts = raw.split(/\s+/)
    if (parts.length > 1) return { cmd: parts[0], baseArgs: parts.slice(1) }
    if (isScriptPath(raw)) return { cmd: execPath, baseArgs: [raw] }
    return { cmd: raw, baseArgs: [] }
  }
  const dirs = String(pathEnv ?? "").split(path.delimiter).filter(Boolean)
  const winNames = platform === "win32" ? names.flatMap((n) => [`${n}.exe`, `${n}.cmd`, n]) : names
  for (const dir of dirs) {
    for (const name of winNames) {
      const p = path.join(dir, name)
      try {
        if (exists(p)) return { cmd: p, baseArgs: [] }
      } catch {}
    }
  }
  return { cmd: names[0], baseArgs: [] }
}

export function resolveZcodeCommand(binCfg = "", opts = {}) {
  return resolveCommandOnPath(binCfg, ["zcode"], opts)
}

export function resolveHerdrCommand(binCfg = "", opts = {}) {
  return resolveCommandOnPath(binCfg, ["herdr"], opts)
}

// pane 里真正跑的 runtime cjs：npm 启动器在 herdr PTY 里会卡死 TUI，必须绕过。
// 显式 tuiBin > 解析出的脚本本身（.cjs 直用）> npm 包内 vendor/zcode.cjs（PATH 上的 zcode 是
// 指向 bin/zcode.js 的无扩展名符号链接，realpath 后按包结构找 vendor）。都找不到就留裸命令，
// start() 会报可读错误。
export function resolveZcodeRuntimeCjs(tuiBinCfg = "", zcodeCmd = { cmd: "", baseArgs: [] }, { execPath = process.execPath, exists = (p) => fs.existsSync(p) } = {}) {
  const explicit = String(tuiBinCfg ?? "").trim()
  if (explicit) {
    const parts = explicit.split(/\s+/)
    if (parts.length > 1) return { cmd: parts[0], baseArgs: parts.slice(1) }
    if (isScriptPath(explicit)) return { cmd: execPath, baseArgs: [explicit] }
    return { cmd: explicit, baseArgs: [] }
  }
  // 候选脚本：baseArgs 里的脚本，或命令本身（realpath——npm 全局 bin 是无扩展名符号链接）。
  let script = String(zcodeCmd.baseArgs?.[0] ?? "")
  if (!script) {
    try {
      const real = fs.realpathSync(String(zcodeCmd.cmd ?? ""))
      if (isScriptPath(real)) script = real
    } catch {}
  }
  if (script && /\.cjs$/i.test(script)) return { cmd: zcodeCmd.cmd, baseArgs: [script] }
  if (script && isScriptPath(script)) {
    // npm 启动器形如 <pkg>/bin/zcode.js → 同包 vendor/zcode.cjs。
    const pkg = script.replace(/[\\/]+bin[\\/]+[^\\/]+\.js$/i, "")
    if (pkg !== script) {
      const vendor = path.join(pkg, "vendor", "zcode.cjs")
      if (exists(vendor)) return { cmd: execPath, baseArgs: [vendor] }
    }
    // 其他脚本按启动器用（测试的 fake 就是这种）。
    return { cmd: zcodeCmd.cmd, baseArgs: [script] }
  }
  return { cmd: String(zcodeCmd.cmd || "zcode"), baseArgs: zcodeCmd.baseArgs ?? [] }
}

// herdr pane 里进程输出 JSON；pane run / send-keys 这类可能没有——尽力解析。
function tryJson(text) {
  try {
    return extractJson(text)
  } catch {
    return null
  }
}

function shQuote(s) {
  return `'${String(s ?? "").replace(/'/g, `'\\''`)}'`
}

// ---- 账本：名字 / 伪 id / convId / sessionId 互查，重启后仍可解析 ----
class ZcodeLedger {
  constructor(ledgerFile, log = () => {}) {
    this.file = ledgerFile
    this.log = log
    this.data = { version: 1, sessions: {}, aliases: {} }
    if (ledgerFile && fs.existsSync(ledgerFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
        if (parsed && typeof parsed === "object") {
          this.data = { version: 1, sessions: parsed.sessions ?? {}, aliases: parsed.aliases ?? {} }
        }
      } catch (e) {
        this.log(`zcode 账本读不回（当新账本用）：${e.message}`)
      }
    }
  }

  save() {
    if (!this.file) return
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data))
    fs.renameSync(tmp, this.file)
  }

  put(entry, aliases = []) {
    for (const a of [entry.key, entry.name, entry.convId, entry.sessionId, ...aliases]) {
      const k = String(a ?? "").trim()
      if (k) this.data.aliases[k] = entry.key
    }
    this.data.sessions[entry.key] = entry
    this.save()
  }

  // 纯查：名字 / 伪 id / convId / sessionId 任一别名。查不到就是查不到。
  resolve(target) {
    const t = String(target ?? "").trim()
    if (!t) return null
    const key = this.data.aliases[t]
    return key ? this.data.sessions[key] ?? null : null
  }

  // 续说兜底：账本里没有但长得像 zcode 会话 id（sess_*）的，就地建档继续用。
  targetForResume(target) {
    const entry = this.resolve(target)
    if (entry) return entry
    const t = String(target ?? "").trim()
    if (/^sess_/.test(t)) {
      const made = { key: t, name: t, sessionId: t, convId: t, cwd: "", status: "done", lastReply: "", updatedAt: Date.now() }
      this.put(made)
      return made
    }
    throw new ZcodeError(`zcode 账本里没有会话：${target}（可能从没派过，或账本被清了）`, { code: "session_missing", target: t })
  }

  entry(target) {
    const entry = this.resolve(target)
    if (!entry) throw new ZcodeError(`zcode 账本里没有会话：${target}（可能从没派过，或账本被清了）`, { code: "session_missing", target: String(target ?? "") })
    return entry
  }

  // 每轮对话留痕（user prompt 摘要 + assistant 回复），控制台 Chat 页用——
  // 只留最近 40 轮，防长会话把账本撑爆。
  recordTurn(entry, { reply = "", prompt = "", status = "done", error = "" } = {}) {
    entry.status = status
    entry.lastReply = String(reply ?? "")
    entry.error = String(error ?? "")
    entry.updatedAt = Date.now()
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
    entry.pid = 0
    this.save()
  }

  adoptSessionId(entry, sessionId) {
    if (sessionId && sessionId !== entry.sessionId) {
      entry.sessionId = sessionId
      this.data.aliases[sessionId] = entry.key
    }
  }

  remove(entry) {
    for (const [alias, key] of Object.entries(this.data.aliases)) {
      if (key === entry.key) delete this.data.aliases[alias]
    }
    delete this.data.sessions[entry.key]
    this.save()
  }
}

// ---- 派活骨架：每会话一条执行链 + status/info/waitFinished 形状 ----
// 同一会话的多轮严格串行：上一轮没跑完时 steer/notify 排队（私有方法不能跨类继承，用模块函数）。
function enqueueChain(chains, key, fn) {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(key, next.catch(() => {}))
  return next
}

class ZcodeDriverBase {
  constructor({ ledger, log = () => {} } = {}) {
    this.log = log
    this.ledger = new ZcodeLedger(ledger, log)
    this.ledgerFile = ledger
    // 阻塞跑首轮/续跑中的会话（并发轮询得看得到它在跑）。
    this.blocking = new Set()
    // 已排队还没提交进 TUI 的后台轮（resumeBackground/openNew 同步标记，补 isRunning 的空窗）。
    this.queued = new Set()
    // 每会话一条执行链：同一会话的多轮严格串行（上一轮没跑完时 steer/notify 排队）。
    this.chains = new Map()
    this.seq = 0
  }

  markRunning(entry) {
    entry.status = "running"
    entry.updatedAt = Date.now()
    this.ledger.put(entry)
  }

  // 统一的 status 形状（service.mjs 的 judgePoll 指纹全压在这些字段上）。
  statusShape(entry, running) {
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
    const entry = this.ledger.entry(target)
    const messages = Array.isArray(entry.messages)
      ? entry.messages
      : [{ role: "assistant", text: String(entry.lastReply ?? ""), finished: true }]
    return {
      name: entry.name,
      messages,
      running: await this.isRunning(entry),
      lastReply: String(entry.lastReply ?? ""),
      sessionId: entry.sessionId || "",
      status: entry.status,
    }
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

// ---- herdr 驱动：zcode TUI 常驻 herdr pane，pane run 投递、插件上报状态机 ----
const HERDR_SOURCE = "herdr-zcode"
const HERDR_AGENT = "zcode"
// TUI 就绪等待 / 首轮接管等待 / 阻塞轮总超时（1 小时）。
const READY_TIMEOUT_MS = 45000
const STALL_TIMEOUT_MS = 20000
const TURN_TIMEOUT_MS = 3600000
const POLL_MS = 2000

const HERDR_ERRORS = {
  bin_missing: "找不到 herdr 可执行文件（可配 herdr.bin；brew install herdr）",
  herdr_server_down: "herdr server 没在跑（跑一次 `herdr server` 或 foreman doctor --start 会自动拉起）",
  herdr_not_ready: "zcode TUI 没能在 herdr pane 里就绪（检查 herdr-zcode 插件是否装好：~/.zcode/cli/setting.json 的 plugins.dirs）",
  agent_blocked: "zcode 在等权限确认（去 herdr 的那个 pane 批一下，或 foreman zcode-stop 后重派）",
  agent_stalled: "prompt 提交后 zcode 没有开始干活（插件没上报 working；检查 herdr-zcode 插件）",
}

export class ZcodeHerdrDriver extends ZcodeDriverBase {
  constructor({ bin = "", herdrBin = "", tuiBin = "", ledger, log = () => {} } = {}) {
    super({ ledger, log })
    this.herdr = resolveHerdrCommand(herdrBin)
    this.zcode = resolveZcodeCommand(bin)
    this.runtime = resolveZcodeRuntimeCjs(tuiBin, this.zcode)
    this.reportSeq = 0
    // 后台轮的轮询定时器：key → timer，archive 时清。
    this.pollers = new Map()
  }

  #nextSeq() {
    this.reportSeq += 1
    return `${Date.now()}${String(this.reportSeq).padStart(4, "0")}`
  }

  classify(code, message = "") {
    const m = String(message ?? "")
    if (code === "ENOENT") return "bin_missing"
    if (code === "timeout") return "herdr_timeout"
    if (/server is not running|could not connect|No such file or directory.*\.sock|connection refused/i.test(m)) return "herdr_server_down"
    if (/agent_blocked/i.test(m)) return "agent_blocked"
    return "herdr_error"
  }

  #fail(args, e) {
    const code = this.classify(e?.code, `${e?.stderr ?? ""}\n${e?.stdout ?? ""}\n${e?.message ?? ""}`)
    const blob = String(e?.stderr || e?.stdout || e?.message || "").trim()
    throw new ZcodeError(HERDR_ERRORS[code] || `herdr ${(args?.[0] ?? "")} 失败：${blob.slice(-800)}`, { code: code === "herdr_timeout" ? "zcode_timeout" : code })
  }

  // herdr CLI 出口：默认按 JSON 解析；lenient=true 时容许非 JSON 输出。
  async #h(args, { timeout = 120000, lenient = false } = {}) {
    let r
    try {
      r = await exec(this.herdr.cmd, [...this.herdr.baseArgs, ...args], { timeout })
    } catch (e) {
      this.#fail(args, e)
    }
    if (lenient) return tryJson(r.stdout)
    const parsed = tryJson(r.stdout)
    if (!parsed) {
      throw new ZcodeError(`herdr ${(args[0] ?? "")} 输出不是 JSON：${r.stdout.slice(-400)}`, { args })
    }
    if (parsed.error) {
      const code = this.classify("", `${parsed.error.code ?? ""} ${parsed.error.message ?? ""}`)
      throw new ZcodeError(HERDR_ERRORS[code] || `herdr ${(args[0] ?? "")} 失败：${String(parsed.error.message ?? "").slice(-400)}`, { code: code === "herdr_error" ? "zcode_error" : code })
    }
    return parsed
  }

  async #json(args, opts) {
    return this.#h(args, opts)
  }

  // workspace create 的 JSON 落在 .result 下；抽取常用句柄。
  #handles(parsed) {
    const r = parsed?.result ?? parsed ?? {}
    return { workspaceId: r.workspace?.workspace_id ?? "", paneId: r.root_pane?.pane_id ?? "" }
  }

  // pane 里的启动命令：env 前缀带上 HERDR_* 与占位 session id（绕开 TUI 冷启动卡死），再接 runtime。
  #launchCommand(paneId, tuiLog = "") {
    const argv = [
      "env",
      "HERDR_ENV=1",
      `HERDR_BIN_PATH=${this.herdr.cmd}`,
      `HERDR_PANE_ID=${paneId}`,
      `ZCODE_SESSION_ID=sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
      ...(tuiLog ? [`ZCODE_TUI_RUNTIME_LOG=${shQuote(tuiLog)}`] : []),
      ...[this.runtime.cmd, ...this.runtime.baseArgs].map(shQuote),
    ]
    const line = argv.join(" ")
    this.log(`herdr 启动命令：${line}`)
    return line
  }

  // 驱动先手动上报一次，让 herdr-zcode 这个 source 持有 pane；插件随后的上报才接得上。
  async #registerAgent(paneId) {
    try {
      await this.#h(["pane", "report-agent", paneId, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT, "--state", "unknown", "--seq", this.#nextSeq()], { lenient: true, timeout: 30000 })
    } catch {}
  }

  // TUI 就绪：只轮询 pane read 等主屏签名（输入框提示语或状态页脚——recent 窗口在屏幕底部，
  // 顶部标题框够不着）。注意此时绝不能碰 agent get / report-agent——pane 还没注册成 agent 时
  // 这些是纯读（安全）；一旦先注册再轮询，herdr 对已注册 pane 的检测会打断正在启动的 TUI
  // （实测 splash 卡死，2026-11）。所以顺序必须是：主屏 → 注册。
  async #waitReady(paneId, { timeoutMs = READY_TIMEOUT_MS } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const text = await this.#readPane(paneId, 12).catch(() => "")
      if (/Ask a task about this|◈ .+ ─ ◉ /i.test(text)) return
      await sleep(1500)
    }
    throw new ZcodeError(HERDR_ERRORS.herdr_not_ready, { code: "herdr_not_ready" })
  }

  // agent 状态 + 状态迁移序号（插件每次 idle/working/blocked 迁移都会推高 seq，做完成判定用）。
  async #agentState(paneId) {
    const parsed = await this.#json(["agent", "get", paneId], { timeout: 30000 })
    const a = parsed?.result?.agent ?? {}
    return { status: String(a.agent_status ?? ""), seq: Number(a.state_change_seq ?? 0) }
  }

  async #readPane(paneId, lines = 120) {
    const r = await exec(this.herdr.cmd, [...this.herdr.baseArgs, "pane", "read", paneId, "--source", "recent", "--lines", String(lines)], { timeout: 30000 })
    return String(r.stdout ?? "")
  }

  // 提交 prompt：pane run = 原子「粘贴文本 + 回车」。超长转临时文件让 agent 自己读。
  async #submit(entry, prompt) {
    const text = String(prompt ?? "")
    let body = text
    let scratch = null
    if (Buffer.byteLength(text, "utf8") > ARGV_PROMPT_MAX) {
      scratch = path.join(os.tmpdir(), `foreman-zcode-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      fs.writeFileSync(scratch, text)
      // 指路文件：TUI 的 cwd 在 repo 里，绝对路径直读。
      body = `请先完整阅读文件 ${scratch} 中的全部指令，然后严格按其内容执行；完成后可以删除该文件。`
    }
    await this.#h(["pane", "run", entry.paneId, body], { lenient: true, timeout: 60000 })
    if (scratch) {
      // 不立刻删：agent 要读它；由轮次收尾时清理。
      entry.scratchFile = scratch
    }
  }

  #cleanupScratch(entry) {
    if (entry?.scratchFile) {
      try {
        fs.rmSync(entry.scratchFile, { force: true })
      } catch {}
      entry.scratchFile = undefined
    }
  }

  // 等一轮跑完：以插件的状态迁移序号为准——提交前记基线 seq，之后看到 idle/done 且 seq 高于
  // 基线即完成（快轮次不会漏）；blocked 立刻报错；seq 一直不动说明提交没被接管（插件没上报）。
  async #waitTurn(entry, { timeoutMs = TURN_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
    const started = Date.now()
    const baseline = await this.#agentState(entry.paneId).then((s) => s.seq, () => 0)
    let sawWorking = false
    while (Date.now() - started < timeoutMs) {
      if (!this.ledger.resolve(entry.key)) return // 会话被 archive，别再等了
      const { status: st, seq } = await this.#agentState(entry.paneId).catch(() => ({ status: "", seq: baseline }))
      if (st === "working") sawWorking = true
      else if (st === "blocked") throw new ZcodeError(HERDR_ERRORS.agent_blocked, { code: "agent_blocked" })
      else if ((st === "idle" || st === "done") && seq > baseline) return
      else if ((st === "idle" || st === "done") && Date.now() - started > STALL_TIMEOUT_MS) {
        // 提交后状态机一直没动：prompt 没进 TUI 或插件没上报。
        throw new ZcodeError(sawWorking ? "zcode 这轮结束后没有新的状态上报（插件异常？）" : HERDR_ERRORS.agent_stalled, { code: "agent_stalled" })
      }
      await sleep(pollMs)
    }
    throw new ZcodeError(`zcode 这一轮跑超时了（${Math.round(timeoutMs / 60000)} 分钟，pane 还在跑可去 herdr 看）`, { code: "zcode_timeout" })
  }

  // zcode 的会话 id：从它的 sqlite 尽力回查（目录 + 建会话时间窗）。
  async #latestSessionId(dir, sinceMs) {
    if (!dir) return ""
    const dbPath = process.env.ZCODE_SESSION_DB_PATH || path.join(expandHome("~/.zcode"), "cli", "db", "db.sqlite")
    if (!fs.existsSync(dbPath)) return ""
    // /tmp 与 /private/tmp 这类 symlink 要归一，否则对不上库里存的目录。
    let real = String(dir)
    try {
      real = fs.realpathSync(real)
    } catch {}
    const since = Number.isFinite(sinceMs) ? sinceMs - 60_000 : 0
    const esc = real.replace(/'/g, "''")
    try {
      const r = await exec("sqlite3", [dbPath, `SELECT id FROM session WHERE directory='${esc}' AND time_created>=${since} ORDER BY time_created DESC LIMIT 1`], { timeout: 15000 })
      return String(r.stdout ?? "").trim()
    } catch {
      return ""
    }
  }

  // 阻塞一轮：拿回复 → 回填账本。
  async #turnBlocking({ entry, prompt }) {
    this.markRunning(entry)
    this.blocking.add(entry.key)
    const startedAt = Date.now()
    try {
      await this.#submit(entry, prompt)
      await this.#waitTurn(entry)
      const text = await this.#readPane(entry.paneId, 120)
      this.ledger.adoptSessionId(entry, await this.#latestSessionId(entry.cwd, startedAt))
      this.ledger.recordTurn(entry, { reply: text.trim().slice(-4000), prompt })
      this.#cleanupScratch(entry)
      return { response: entry.lastReply }
    } catch (e) {
      this.ledger.recordTurn(entry, { status: "error", error: e.message, prompt })
      this.#cleanupScratch(entry)
      throw e
    } finally {
      this.blocking.delete(entry.key)
    }
  }

  // 后台一轮：提交后起轮询，idle/done 时回填账本。
  async #turnBackground({ entry, prompt }) {
    this.markRunning(entry)
    const startedAt = Date.now()
    try {
      await this.#submit(entry, prompt)
    } catch (e) {
      this.ledger.recordTurn(entry, { status: "error", error: e.message, prompt })
      this.#cleanupScratch(entry)
      return
    }
    await new Promise((resolveBg) => {
      const tick = async () => {
        if (!this.ledger.resolve(entry.key)) {
          this.#cleanupScratch(entry)
          resolveBg()
          return
        }
        const { status: st } = await this.#agentState(entry.paneId).catch(() => ({ status: "" }))
        if (st === "idle" || st === "done") {
          try {
            const text = await this.#readPane(entry.paneId, 120)
            this.ledger.adoptSessionId(entry, await this.#latestSessionId(entry.cwd, startedAt))
            this.ledger.recordTurn(entry, { reply: text.trim().slice(-4000), prompt })
          } catch (e) {
            this.ledger.recordTurn(entry, { status: "error", error: `这轮跑完了但读屏失败：${e.message}`, prompt })
          }
          this.#cleanupScratch(entry)
          this.pollers.delete(entry.key)
          resolveBg()
        } else if (st === "blocked") {
          this.ledger.recordTurn(entry, { status: "error", error: HERDR_ERRORS.agent_blocked, prompt })
          this.#cleanupScratch(entry)
          this.pollers.delete(entry.key)
          resolveBg()
        } else {
          const t = setTimeout(tick, POLL_MS)
          t.unref?.() // 别让轮询定时器拖住进程退出
          this.pollers.set(entry.key, t)
        }
      }
      tick()
    })
  }

  // 新会话公共段：建 workspace → 起运行时 → 等主屏 → 注册 agent。返回账本条目。
  async #provision({ name, repo = "" }) {
    const cwd = String(repo ?? "").trim() || process.cwd()
    const parsed = await this.#json(["workspace", "create", "--cwd", cwd, "--label", String(name).slice(0, 60), "--no-focus", "--env", "ZCODE_DISABLE_UPDATE_CHECK=1"], { timeout: 60000 })
    const { workspaceId, paneId } = this.#handles(parsed)
    if (!paneId) throw new ZcodeError(`herdr workspace create 没返回 pane id：${JSON.stringify(parsed).slice(-300)}`)
    this.tuiLog = path.join(path.dirname(this.ledger.file || "state.json"), `tui-${paneId.replace(/[^A-Za-z0-9]/g, "_")}.log`)
    await this.#h(["pane", "run", paneId, this.#launchCommand(paneId, this.tuiLog)], { lenient: true, timeout: 60000 })
    // 顺序不能反：先等 TUI 主屏，再注册 agent（注册后才能开始 agent get 轮询，见 #waitReady 注释）。
    await this.#waitReady(paneId)
    await this.#registerAgent(paneId)
    return { workspaceId, paneId, cwd }
  }

  async open({ name, repo = "", prompt }) {
    const key = String(name ?? "").trim() || `zcode-open-${++this.seq}`
    this.log(`zcode open ${key}（herdr，阻塞跑首轮）`)
    const entry = { key, name: key, sessionId: "", convId: "", paneId: "", workspaceId: "", cwd: String(repo ?? ""), status: "running", lastReply: "", updatedAt: Date.now() }
    return enqueueChain(this.chains, key, async () => {
      try {
        const prov = await this.#provision({ name: key, repo })
        Object.assign(entry, prov, { convId: prov.paneId })
        this.ledger.put(entry)
        await this.#turnBlocking({ entry, prompt })
        return { ok: true, convId: entry.convId, name: key, sessionId: entry.sessionId, response: entry.lastReply }
      } catch (e) {
        // workspace 建出来但后续失败：句柄留在账本里（archive 能收尾），状态落 error 免得永远 running。
        this.ledger.recordTurn(entry, { status: "error", error: e.message })
        throw e
      }
    })
  }

  async openNew({ name, prompt, noWait = true }) {
    const key = String(name ?? "").trim() || `zcode-new-${++this.seq}`
    if (!noWait) return this.open({ name: key, prompt })
    const slug = key.replace(/\s+/g, "-").slice(0, 60)
    const pseudo = `zcode-${slug}-${++this.seq}`
    this.log(`zcode open ${key}（herdr 后台跑首轮，伪 id ${pseudo}）`)
    const entry = { key: pseudo, name: key, sessionId: "", convId: "", paneId: "", workspaceId: "", cwd: "", status: "running", lastReply: "", updatedAt: Date.now() }
    this.ledger.put(entry, [key])
    this.queued.add(pseudo)
    // 新会话没有前轮要排队：直接开工，保证 deliver 返回时 status 立刻可见 running。
    enqueueChain(this.chains, pseudo, async () => {
      try {
        const prov = await this.#provision({ name: key, repo: "" })
        Object.assign(entry, prov, { convId: prov.paneId })
        this.ledger.put(entry)
        await this.#turnBackground({ entry, prompt })
      } catch (e) {
        this.ledger.recordTurn(entry, { status: "error", error: e.message, prompt })
      }
    }).catch(() => {}).finally(() => this.queued.delete(pseudo))
    return { ok: true, convId: pseudo, name: key, sessionId: "", background: true }
  }

  async send(name, text) {
    const entry = this.ledger.entry(name)
    this.log(`zcode send ${entry.name}（herdr 阻塞续跑）`)
    await enqueueChain(this.chains, entry.key, async () => {
      if (!entry.paneId) throw new ZcodeError(`会话 ${entry.name} 还没拿到 herdr pane（可能首轮还没建好），稍后再发`, { code: "zcode_error" })
      await this.#turnBlocking({ entry, prompt: text })
    })
    return { ok: true, convId: entry.convId, name: entry.name, response: entry.lastReply }
  }

  // notify/steer/queue：排队投进 TUI（输入框自动排队），只确认「派出去了」。
  // 同步先标 running——派单返回的那一刻 watch 就能看到在跑。
  #resumeBackground(target, text, label) {
    const entry = this.ledger.targetForResume(target)
    this.log(`zcode ${label} ${entry.name}（herdr 排队后台续跑）`)
    this.markRunning(entry)
    this.queued.add(entry.key)
    enqueueChain(this.chains, entry.key, async () => {
      if (!entry.paneId) throw new ZcodeError(`会话 ${entry.name} 还没拿到 herdr pane`, { code: "zcode_error" })
      await this.#turnBackground({ entry, prompt: text })
    }).catch(() => {}).finally(() => this.queued.delete(entry.key))
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

  async status(target) {
    const entry = this.ledger.entry(target)
    return this.statusShape(entry, await this.isRunning(entry))
  }

  async isRunning(entry) {
    if (entry.status !== "running") return false
    if (this.blocking.has(entry.key) || this.pollers.has(entry.key) || this.queued.has(entry.key)) return true
    if (!entry.paneId) return true // 还在建 workspace/pane，算跑着
    const { status: st } = await this.#agentState(entry.paneId).catch(() => ({ status: "" }))
    return st === "working" || st === "blocked"
  }

  async runningMap() {
    // pane → 状态一次拿全；pane 消失按没在跑算（条目仍在 map，watch 的 gone 语义是「不在 map」）。
    let states = {}
    try {
      const parsed = await this.#json(["agent", "list"], { timeout: 30000 })
      for (const a of parsed?.result?.agents ?? []) states[a.pane_id] = String(a.agent_status ?? "")
    } catch {}
    const out = {}
    for (const entry of Object.values(this.ledger.data.sessions)) {
      const st = entry.paneId ? states[entry.paneId] ?? "" : ""
      const running = entry.status === "running" && (this.blocking.has(entry.key) || this.pollers.has(entry.key) || !entry.paneId || st === "working" || st === "blocked")
      const shape = { running, title: entry.name, active: false }
      // watch 绑的是派单时返回的句柄：openNew 的伪 id（entry.key）、open 的 paneId、真 sess id
      // 都可能是 watch 目标，三键全给（去重）。
      for (const k of new Set([entry.convId, entry.key, entry.sessionId].filter(Boolean))) {
        out[k] = shape
      }
    }
    return out
  }

  async archive(target) {
    const entry = this.resolve(target)
    if (entry) {
      this.stop(entry.key)
      if (entry.workspaceId) {
        await this.#h(["workspace", "close", entry.workspaceId], { lenient: true, timeout: 30000 }).catch(() => {})
      }
      const timer = this.pollers.get(entry.key)
      if (timer) clearTimeout(timer)
      this.pollers.delete(entry.key)
      this.ledger.remove(entry)
      this.log(`zcode archive ${entry.name}（关 herdr workspace，清账本）`)
    }
    return { ok: true }
  }

  // stop：给 pane 发 esc 打断当前轮/关掉权限对话框（会话本身还在，可继续 send）。
  stop(target) {
    const entry = this.resolve(target)
    if (!entry?.paneId) return { ok: false, stopped: false }
    const { cmd, baseArgs } = this.herdr
    for (const key of ["escape", "escape"]) {
      try {
        const child = spawn(cmd, [...baseArgs, "pane", "send-keys", entry.paneId, key], { stdio: "ignore", detached: true })
        child.unref()
      } catch {}
    }
    return { ok: true, stopped: true }
  }

  // start：doctor --start——herdr 版本/server/zcode runtime/插件四项检查，能拉则拉。
  async start() {
    const problems = []
    // 1) herdr 本体
    let herdrVersion = ""
    try {
      const r = await exec(this.herdr.cmd, [...this.herdr.baseArgs, "--version"], { timeout: 30000 })
      herdrVersion = String(r.stdout ?? "").trim().split("\n")[0]
      const mm = /(\d+)\.(\d+)\.(\d+)/.exec(herdrVersion)
      if (mm) {
        const [maj, min, pat] = mm.slice(1).map(Number)
        if (maj * 10000 + min * 100 + pat < 905) problems.push(`herdr 需要 ≥0.9.5（现在 ${herdrVersion}，brew upgrade herdr）`)
      }
    } catch (e) {
      throw new ZcodeError(`herdr 不可用：${String(e.stderr || e.message).slice(-200)}`, { code: "bin_missing" })
    }
    // 2) server（没跑就分离拉起，再探一次）
    let serverOk = false
    try {
      const r = await exec(this.herdr.cmd, [...this.herdr.baseArgs, "status", "server"], { timeout: 15000 })
      serverOk = /running/i.test(String(r.stdout ?? ""))
    } catch {}
    if (!serverOk) {
      try {
        const child = spawn(this.herdr.cmd, [...this.herdr.baseArgs, "server"], { stdio: "ignore", detached: true, env: { ...process.env } })
        child.unref()
      } catch {}
      await sleep(2500)
      try {
        const r = await exec(this.herdr.cmd, [...this.herdr.baseArgs, "status", "server"], { timeout: 15000 })
        serverOk = /running/i.test(String(r.stdout ?? ""))
      } catch {}
    }
    if (!serverOk) problems.push("herdr server 没起来（手动跑 `herdr server` 看报错）")
    // 3) zcode runtime（直接跑 cjs 的 --version；启动器在 pane 里会卡，这里不经过它）
    let zcVersion = ""
    if (this.runtime.baseArgs.length > 0 && isScriptPath(this.runtime.baseArgs[0])) {
      try {
        const r = await exec(this.runtime.cmd, [...this.runtime.baseArgs, "--version"], { timeout: 60000 })
        zcVersion = String(r.stdout ?? "").trim().split("\n").find(Boolean) ?? ""
      } catch (e) {
        problems.push(`zcode runtime 探活失败：${String(e.stderr || e.message).slice(-160)}`)
      }
    } else {
      problems.push("找不到 zcode runtime cjs（可配 zcode.tuiBin，如 `node /path/vendor/zcode.cjs`）")
    }
    // 4) herdr-zcode 插件：查 setting.json 的 plugins.dirs 里有没有装好
    const pluginOk = this.#pluginInstalled()
    if (!pluginOk) problems.push("herdr-zcode 插件没装：zcode plugins marketplace 指向 zcode-cli 仓库的 integrations/herdr，或把插件目录挂进 ~/.zcode/cli/setting.json 的 plugins.dirs")
    if (problems.length) throw new ZcodeError(problems.join("；"), { code: "zcode_error" })
    return { ok: true, version: `${herdrVersion} / ${zcVersion}`.trim() }
  }

  #pluginInstalled() {
    const p = expandHome(process.env.ZCODE_CLI_SETTINGS_FILE || path.join(expandHome("~/.zcode"), "cli", "setting.json"))
    let dirs = []
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
      dirs = parsed?.plugins?.dirs ?? []
    } catch {
      return false
    }
    for (const d of dirs) {
      const manifest = path.join(expandHome(String(d)), ".zcode-plugin", "plugin.json")
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8"))?.name === HERDR_SOURCE) return true
      } catch {}
    }
    return false
  }

  resolve(target) {
    return this.ledger.resolve(target)
  }
}
