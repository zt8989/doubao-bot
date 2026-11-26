// zcode 转录只读源：直读 ~/.zcode/cli/db/db.sqlite 的 session/message/part 三张表。
//
// zcode（TUI 与 CreateSession 子会话都一样）每步落库：message 一行带 role/model/completed，
// part 按块拆（step-start / reasoning / text / tool / step-finish），time_updated 随每步推进，
// tool part 的 data.state.status 还带运行状态。对这张库做「time_updated > 游标」的增量轮询，
// 就是秒级「步进式实时」——比账本回填（整轮跑完才有一条）细一个量级。
//
// 只读不写：一律 sqlite3 -readonly -json（sqlite3 CLI 是 zcodedrv 已有的依赖）；foreman 不碰
// zcode 的写连接，WAL 下读也不阻塞它。库路径 ZCODE_SESSION_DB_PATH > cfg.zcode.dbPath > 默认。
//
// 已实测（2026-11，本机生产库）：CreateSession 子会话 task_type='subagent_child'、parent_id 指向
// 父会话——子智能体树直接从这两列建，不依赖 foreman 账本。
import fs from "node:fs"
import { exec, expandHome } from "./util.mjs"

// 长文本（推理块/工具输出）过闸：留头 2K + 尾 6K，防止 SSE 帧和前端内存被单块撑爆。
export function clampText(text, { head = 2000, tail = 6000 } = {}) {
  const s = String(text ?? "")
  if (s.length <= head + tail + 20) return s
  return `${s.slice(0, head)}\n…（中间截断 ${s.length - head - tail} 字）…\n${s.slice(-tail)}`
}

const esc = (s) => String(s ?? "").replace(/'/g, "''")

export function defaultDbPath() {
  return process.env.ZCODE_SESSION_DB_PATH || expandHome("~/.zcode/cli/db/db.sqlite")
}

function rowsFromStdout(stdout) {
  const text = String(stdout ?? "").trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// data 列是 zcode 自己写的 JSON，防御性解析——坏行不炸整轮查询。
function parseData(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export class ZcTranscript {
  constructor({ dbPath = "", log = () => {} } = {}) {
    this.dbPath = String(dbPath ?? "").trim() || defaultDbPath()
    this.log = log
  }

  available() {
    return fs.existsSync(this.dbPath)
  }

  async #query(sql, { timeout = 15000 } = {}) {
    if (!this.available()) throw Object.assign(new Error(`zcode 会话库不存在：${this.dbPath}`), { code: "db_missing" })
    let r
    try {
      r = await exec("sqlite3", ["-readonly", "-json", this.dbPath, sql], { timeout })
    } catch (e) {
      throw Object.assign(new Error(`zcode 会话库查询失败：${String(e.stderr || e.message).slice(-200)}`), { code: "db_query_failed" })
    }
    return rowsFromStdout(r.stdout)
  }

  // 最近的会话行（含 parent_id / task_type），建树与列表共用。
  async listSessions({ sinceMs = 0, limit = 400 } = {}) {
    const since = Number.isFinite(sinceMs) ? Math.floor(sinceMs) : 0
    const cap = Math.min(Math.max(1, Math.floor(limit) || 400), 2000)
    const rows = await this.#query(
      `SELECT id, parent_id AS parentId, title, directory, task_type AS taskType,
              time_created AS timeCreated, time_updated AS timeUpdated
       FROM session WHERE time_updated > ${since}
       ORDER BY time_updated DESC LIMIT ${cap}`,
    )
    return rows.map((r) => ({ ...r, parentId: r.parentId || "" }))
  }

  // 一条会话的增量转录行：message 元数据 + part 内容，扁平打包（前端按 id 合并）。
  async tail(sessionId, { sinceMs = 0 } = {}) {
    const id = esc(sessionId)
    if (!id) return { messages: [], parts: [], cursor: Number(sinceMs) || 0 }
    const since = Number.isFinite(sinceMs) ? Math.floor(sinceMs) : 0
    const messages = (await this.#query(
      `SELECT id, time_created AS timeCreated, time_updated AS timeUpdated, data
       FROM message WHERE session_id='${id}' AND time_updated > ${since}
       ORDER BY time_created, id`,
    )).map((r) => {
      const data = parseData(r.data)
      return {
        kind: "message",
        id: r.id,
        timeCreated: r.timeCreated,
        timeUpdated: r.timeUpdated,
        role: String(data.role ?? "assistant"),
        model: [data.providerId, data.modelId].filter(Boolean).join("/"),
        completed: Number(data.time?.completed ?? 0) > 0,
        error: String(data.error ?? "").slice(0, 400),
      }
    })
    const parts = (await this.#query(
      `SELECT id, message_id AS messageId, time_created AS timeCreated, time_updated AS timeUpdated, data
       FROM part WHERE session_id='${id}' AND time_updated > ${since}
       ORDER BY time_created, id`,
    )).map((r) => {
      const data = parseData(r.data)
      const base = {
        kind: "part",
        id: r.id,
        messageId: r.messageId,
        timeCreated: r.timeCreated,
        timeUpdated: r.timeUpdated,
        type: String(data.type ?? ""),
      }
      if (base.type === "reasoning" || base.type === "text") return { ...base, text: clampText(data.text) }
      if (base.type === "tool") {
        return {
          ...base,
          tool: String(data.tool ?? ""),
          callID: String(data.callID ?? ""),
          status: String(data.state?.status ?? ""),
          stateText: clampText(data.state?.output ?? data.state?.input ?? JSON.stringify(data.state ?? {}), { head: 800, tail: 4000 }),
        }
      }
      return base
    })
    let cursor = since
    for (const row of [...messages, ...parts]) cursor = Math.max(cursor, Number(row.timeUpdated) || 0)
    return { messages, parts, cursor }
  }

  // 会话是否在生成：最后一条 assistant message 还没 completed。
  async lastMessage(sessionId) {
    const id = esc(sessionId)
    if (!id) return null
    const rows = await this.#query(
      `SELECT json_extract(data,'$.role') AS role,
              json_extract(data,'$.time.completed') AS completed,
              time_created AS timeCreated
       FROM message WHERE session_id='${id}'
       ORDER BY time_created DESC, id DESC LIMIT 1`,
    )
    return rows[0] ?? null
  }

  // 账本条目缺 sessionId 时的兜底：目录 + 建会话时间窗回查（同 zcodedrv #latestSessionId）。
  async resolveSessionId({ directory, sinceMs } = {}) {
    const dir = esc(directory ?? "")
    if (!dir) return ""
    const since = Number.isFinite(sinceMs) ? Math.floor(sinceMs) - 60_000 : 0
    const rows = await this.#query(
      `SELECT id FROM session WHERE directory='${dir}' AND time_created >= ${since}
       ORDER BY time_created DESC LIMIT 1`,
    )
    return String(rows[0]?.id ?? "")
  }

  // 会话标题（子智能体围观时账本没有名字，取库里的 title）。
  async sessionTitle(sessionId) {
    const id = esc(sessionId)
    if (!id) return ""
    const rows = await this.#query(`SELECT title FROM session WHERE id='${id}' LIMIT 1`)
    return String(rows[0]?.title ?? "")
  }

  // 一批会话的 streaming 标记：各取最近 2 小时内最后一条 message，assistant 未 completed 即在跑。
  // 单查询批量拿，避免 N 次 sqlite3 进程。
  async runningFlags(sessionIds, { withinMs = 2 * 3600_000 } = {}) {
    const ids = [...new Set(sessionIds.filter(Boolean))].slice(0, 150).map(esc)
    const out = {}
    if (!ids.length) return out
    const since = Date.now() - withinMs
    const rows = await this.#query(
      `SELECT session_id AS sid, json_extract(data,'$.role') AS role,
              json_extract(data,'$.time.completed') AS completed, time_created AS timeCreated
       FROM message WHERE time_updated >= ${since}
         AND session_id IN (${ids.map((i) => `'${i}'`).join(",")})
       ORDER BY time_created ASC`,
    )
    for (const r of rows) out[r.sid] = { role: String(r.role ?? ""), completed: Number(r.completed ?? 0) > 0, timeCreated: r.timeCreated }
    const flags = {}
    for (const [sid, last] of Object.entries(out)) flags[sid] = last.role === "assistant" && !last.completed
    return flags
  }
}

// 可围观会话树：根 = rootIds（foreman 账本/router 会话），子 = parent 链 3 跳内挂到根的会话
// （孙会话缩到根名下、depth 递增）。纯函数：输入 zcode 库的会话行 + 根 id 集合，输出扁平节点
// （根按更新时间倒序、子紧随其根）。
export function buildWatchTree({ rootIds = new Set(), sessions = [], ledgerInfo = new Map() } = {}) {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const node = (row, { depth, parentId, ledgerName }) => ({
    convId: row.id,
    parentId: parentId || "",
    name: ledgerName || row.title || row.id,
    directory: row.directory || "",
    taskType: row.taskType || "",
    depth,
    inLedger: ledgerInfo.has(row.id),
    ledgerStatus: ledgerInfo.get(row.id)?.status || "",
    timeUpdated: row.timeUpdated || 0,
  })
  const roots = sessions.filter((s) => rootIds.has(s.id)).sort((a, b) => b.timeUpdated - a.timeUpdated)
  const childrenOf = new Map()
  for (const row of sessions) {
    if (rootIds.has(row.id) || !row.parentId) continue
    let cur = row
    let hops = 0
    let attached = ""
    while (cur?.parentId && hops < 3) {
      cur = byId.get(cur.parentId)
      if (!cur) break
      hops += 1
      if (rootIds.has(cur.id)) {
        attached = cur.id
        break
      }
    }
    if (!attached) continue // 挂不到任何根的（比如用户自己的桌面会话）不进树
    if (!childrenOf.has(attached)) childrenOf.set(attached, [])
    childrenOf.get(attached).push({ row, hops })
  }
  const nodes = []
  for (const root of roots) {
    nodes.push(node(root, { depth: 0, parentId: "", ledgerName: ledgerInfo.get(root.id)?.name }))
    const kids = (childrenOf.get(root.id) ?? []).sort((a, b) => b.row.timeUpdated - a.row.timeUpdated)
    for (const { row, hops } of kids) {
      nodes.push(node(row, { depth: hops, parentId: root.id, ledgerName: "" }))
    }
  }
  return nodes
}
