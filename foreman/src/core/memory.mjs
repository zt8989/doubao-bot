import fs from "node:fs"
import path from "node:path"
import { expandHome } from "../util.mjs"

const CORE_FILES = {
  memory: "MEMORY.md",
  user: "USER.md",
}

export function memoryDir(cfg) {
  const raw = expandHome(String(cfg?.memory?.dir ?? "memory").trim() || "memory")
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(cfg.stateFile), raw)
}

function normalizeTarget(target) {
  const value = String(target ?? "").trim().toLowerCase()
  if (!Object.hasOwn(CORE_FILES, value)) throw new Error(`target 只支持 memory|user，现在是：${target}`)
  return value
}

function normalizeKey(key) {
  const value = String(key ?? "").trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("key 需为 1–64 位小写字母、数字、点、下划线或连字符")
  }
  return value
}

function normalizeDay(day) {
  const value = String(day ?? "").trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("day 必须是 YYYY-MM-DD")
  return value
}

function dreamStatePath(dir) {
  return path.join(dir, "dreaming", "state.json")
}

function readDreamState(dir) {
  const file = dreamStatePath(dir)
  if (!fs.existsSync(file)) return { version: 1, days: {} }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  return { version: 1, days: parsed.days && typeof parsed.days === "object" ? parsed.days : {} }
}

function writeDreamState(dir, state) {
  const file = dreamStatePath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function normalizeText(text, maxChars) {
  const value = String(text ?? "").trim()
  if (!value) throw new Error("记忆内容不能为空")
  if (/[\r\n]/.test(value)) throw new Error("MEMORY.md / USER.md 每条记忆只能占一行，请先精简成一条")
  const length = [...value].length
  if (length > maxChars) {
    throw new Error(`单条记忆最多 ${maxChars} 个字符，当前 ${length} 个；请精简后重试，不会自动精简`)
  }
  return value
}

function coreInfo(dir, target) {
  const file = path.join(dir, CORE_FILES[target])
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  return {
    path: file,
    content,
    bytes: Buffer.byteLength(content),
    entries: content.split("\n").filter((line) => line.startsWith("- ")).length,
  }
}

const lockWait = new Int32Array(new SharedArrayBuffer(4))

function withWriteLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, ".write.lock")
  let fd
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      fd = fs.openSync(lock, "wx", 0o600)
      fs.writeFileSync(fd, `${process.pid}\n`)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          fs.unlinkSync(lock)
          continue
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue
        throw statError
      }
      Atomics.wait(lockWait, 0, 0, 10)
    }
  }
  if (fd === undefined) throw new Error("等待记忆写锁超时，请稍后重试")
  try {
    return fn()
  } finally {
    fs.closeSync(fd)
    try {
      fs.unlinkSync(lock)
    } catch {}
  }
}

function writeCore(dir, target, content) {
  const file = path.join(dir, CORE_FILES[target])
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export class MemoryStore {
  constructor(cfg) {
    this.dir = memoryDir(cfg)
    this.maxEntryChars = Number(cfg?.memory?.maxEntryChars ?? 240)
    this.maxBytes = {
      memory: Number(cfg?.memory?.memoryMaxBytes ?? 4000),
      user: Number(cfg?.memory?.userMaxBytes ?? 2000),
    }
  }

  show() {
    return {
      dir: this.dir,
      memory: coreInfo(this.dir, "memory"),
      user: coreInfo(this.dir, "user"),
    }
  }

  daily(day) {
    const value = normalizeDay(day)
    const file = path.join(this.dir, "memory", `${value}.md`)
    return {
      day: value,
      file: `memory/${value}.md`,
      path: file,
      content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
    }
  }

  beginDream({ day, force = false }) {
    const value = normalizeDay(day)
    return withWriteLock(this.dir, () => {
      const state = readDreamState(this.dir)
      const previous = state.days[value]
      if (!force && ["running", "completed"].includes(previous?.status)) {
        return { ok: true, skipped: previous.status === "running" ? "already-running" : "already-completed", day: value, runId: previous.runId }
      }
      const runId = `${value}-${Date.now()}-${process.pid}`
      state.days[value] = { status: "running", runId, startedAt: new Date().toISOString() }
      writeDreamState(this.dir, state)
      return { ok: true, day: value, runId, status: "running" }
    })
  }

  failDream({ day, runId, error }) {
    const value = normalizeDay(day)
    return withWriteLock(this.dir, () => {
      const state = readDreamState(this.dir)
      if (state.days[value]?.runId !== runId) return { ok: true, ignored: "stale-run", day: value }
      state.days[value] = { ...state.days[value], status: "failed", error: String(error || "unknown"), finishedAt: new Date().toISOString() }
      writeDreamState(this.dir, state)
      return { ok: true, status: "failed", day: value, runId }
    })
  }

  dreamStatus() {
    return {
      ok: true,
      diary: "DREAMS.md",
      path: path.join(this.dir, "DREAMS.md"),
      ...readDreamState(this.dir),
    }
  }

  dreamReport({ day, runId, text }) {
    const value = normalizeDay(day)
    const id = String(runId ?? "").trim()
    const summary = String(text ?? "").trim()
    if (!id) throw new Error("dream-report 需要 --run")
    if (!summary) throw new Error("dream-report 需要非空 --text")
    return withWriteLock(this.dir, () => {
      const state = readDreamState(this.dir)
      const current = state.days[value]
      if (current?.runId !== id || !["running", "completed"].includes(current.status)) {
        throw new Error(`${value} 不存在可写报告的 running dreaming：${id}`)
      }
      if (current.status !== "completed") {
        const diary = path.join(this.dir, "DREAMS.md")
        const marker = `<!-- dream-run:${id} -->`
        const existing = fs.existsSync(diary) ? fs.readFileSync(diary, "utf8") : ""
        if (!existing.includes(marker)) fs.appendFileSync(diary, `## ${value}\n\n${marker}\n\n${summary}\n\n`, { mode: 0o600 })
        state.days[value] = { ...current, status: "completed", finishedAt: new Date().toISOString() }
        writeDreamState(this.dir, state)
      }
      return { ok: true, status: "completed", day: value, runId: id, diary: "DREAMS.md", path: path.join(this.dir, "DREAMS.md") }
    })
  }

  set({ target, key, text }) {
    const kind = normalizeTarget(target)
    const id = normalizeKey(key)
    const value = normalizeText(text, this.maxEntryChars)
    return withWriteLock(this.dir, () => {
      const current = coreInfo(this.dir, kind).content
      const marker = `<!-- key:${id};`
      const lines = current ? current.split("\n") : []
      const entry = `- ${value} ${marker} observed:${new Date().toISOString().slice(0, 10)}; status:active -->`
      const index = lines.findIndex((line) => line.includes(marker))
      const action = index >= 0 ? "updated" : "created"
      if (index >= 0) lines[index] = entry
      else lines.push(entry)
      const content = `${lines.join("\n").replace(/\n+$/, "")}\n`
      const bytes = Buffer.byteLength(content)
      const maxBytes = this.maxBytes[kind]
      if (bytes > maxBytes) {
        throw new Error(`${CORE_FILES[kind]} 总长度不能超过 ${maxBytes} 字节，当前 ${bytes} 字节；请精简内容或删除旧条目后重试，不会自动精简或截断`)
      }

      writeCore(this.dir, kind, content)
      return { ok: true, action, target: kind, key: id, ...coreInfo(this.dir, kind) }
    })
  }

  forget({ target, key }) {
    const kind = normalizeTarget(target)
    const id = normalizeKey(key)
    return withWriteLock(this.dir, () => {
      const marker = `<!-- key:${id};`
      const current = coreInfo(this.dir, kind).content
      const lines = current ? current.split("\n") : []
      const remaining = lines.filter((line) => !line.includes(marker))
      if (remaining.length === lines.length) throw new Error(`${CORE_FILES[kind]} 里不存在 key：${id}`)
      const body = remaining.join("\n").replace(/\n+$/, "")
      const content = body ? `${body}\n` : ""
      writeCore(this.dir, kind, content)
      return { ok: true, action: "deleted", target: kind, key: id, ...coreInfo(this.dir, kind) }
    })
  }

  note({ text }) {
    const value = String(text ?? "").trim()
    if (!value) throw new Error("日常笔记不能为空")
    return withWriteLock(this.dir, () => {
      const at = new Date().toISOString()
      const relative = `memory/${at.slice(0, 10)}.md`
      const file = path.join(this.dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `## ${at}\n\n${value}\n\n`, { mode: 0o600 })
      return { ok: true, tier: "episodic", file: relative, path: file }
    })
  }

  search(query, { limit = 8 } = {}) {
    const needle = String(query ?? "").trim().toLowerCase()
    if (!needle) throw new Error("search 需要非空查询词")
    const count = Math.max(1, Math.min(50, Number(limit) || 8))
    const results = []
    for (const target of ["memory", "user"]) {
      const info = coreInfo(this.dir, target)
      info.content.split("\n").forEach((text, index) => {
        if (text.toLowerCase().includes(needle)) {
          results.push({ tier: "curated", file: CORE_FILES[target], line: index + 1, text })
        }
      })
    }
    const notesDir = path.join(this.dir, "memory")
    const files = fs.existsSync(notesDir)
      ? fs.readdirSync(notesDir).filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort().reverse()
      : []
    for (const file of files) {
      const content = fs.readFileSync(path.join(notesDir, file), "utf8")
      const chunks = content.split(/(?=^## )/m)
      let offset = 0
      for (const chunk of chunks) {
        if (chunk.toLowerCase().includes(needle)) {
          results.push({ tier: "episodic", file: `memory/${file}`, line: offset + 1, text: chunk.trim() })
        }
        offset += chunk.split("\n").length
      }
    }
    return { ok: true, query: String(query).trim(), results: results.slice(0, count) }
  }
}

export function memoryBootstrap(cfg) {
  let memory = { content: "" }
  let user = { content: "" }
  let warning = ""
  try {
    const stored = new MemoryStore(cfg).show()
    memory = stored.memory
    user = stored.user
  } catch (error) {
    warning = `记忆读取失败：${error?.message || error}。本轮仍可继续处理任务；需要维护记忆时先检查 memory.dir 与文件权限。`
  }
  return [
    "## 持久记忆",
    warning || "以下是跨会话持久状态。MEMORY.md 保存精简的持久事实与决定，USER.md 保存稳定的用户偏好；日常笔记只在按需检索时读取。",
    "### MEMORY.md",
    memory.content.trim() || "（空）",
    "### USER.md",
    user.content.trim() || "（空）",
    "### 记忆维护规则",
    "禁止直接写入、编辑或覆盖 MEMORY.md / USER.md；只能通过 `foreman memory` 命令更新。核心文件只保留不可从其他系统重新查询的持久信息，不写原始对话、临时状态或任务清单。",
    "- 持久事实或偏好：`foreman memory set --target memory|user --key <稳定键> --text <一条精简内容>`；同一 key 原地替代。USER.md 使用“始终 / 禁止 / 优先”等指令式表述。",
    "- 删除失效条目：`foreman memory forget --target memory|user --key <稳定键>`。",
    "- 日常观察与运行上下文：`foreman memory note --text <内容>`，写入当天日记，不会自动注入。",
    "- 需要历史细节：`foreman memory search <查询词>`；查看核心文件：`foreman memory show`。",
    "写入时如果单条或文件总长度超限，命令会报错；系统不会自动精简、截断或合并，请缩短内容后重试。",
  ].join("\n\n")
}
