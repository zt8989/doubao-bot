// Always-on 原语：SQLite Schedule → durable Inbox → 单 Worker。
// Schedule 只产生事件；Worker 在同一 Node 进程被直接唤醒，轮询仅作漏唤醒与重启恢复兜底。
import { randomUUID } from "node:crypto"
import { nextCronTime } from "./cron.mjs"

const iso = (value = new Date()) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const ACTIVE = "('pending', 'processing')"

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_inbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid          TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,
    text          TEXT NOT NULL DEFAULT '',
    payload       TEXT NOT NULL DEFAULT '{}',
    dedupe_key    TEXT NOT NULL DEFAULT '',
    coalesce_key  TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    reason        TEXT NOT NULL DEFAULT '',
    available_at  TEXT NOT NULL,
    expires_at    TEXT,
    lease_until   TEXT,
    run_id        TEXT NOT NULL DEFAULT '',
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_inbox_ready ON agent_inbox(status, available_at);
  CREATE INDEX IF NOT EXISTS idx_agent_inbox_dedupe ON agent_inbox(dedupe_key, status);
  CREATE INDEX IF NOT EXISTS idx_agent_inbox_coalesce ON agent_inbox(coalesce_key, status);

  CREATE TABLE IF NOT EXISTS agent_schedules (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    cron        TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    next_at     TEXT,
    payload     TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL
  );
`

function parseJson(text) {
  try { return JSON.parse(text || "{}") } catch { return {} }
}

function eventOf(row) {
  if (!row) return null
  return {
    id: Number(row.id), uuid: row.uuid, kind: row.kind, text: row.text, payload: parseJson(row.payload),
    dedupeKey: row.dedupe_key, coalesceKey: row.coalesce_key, status: row.status, reason: row.reason,
    availableAt: row.available_at, expiresAt: row.expires_at || "", leaseUntil: row.lease_until || "",
    runId: row.run_id, attempts: Number(row.attempts), lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function scheduleOf(row) {
  if (!row) return null
  return {
    id: row.id, kind: row.kind, cron: row.cron, enabled: Boolean(row.enabled), nextAt: row.next_at || "",
    payload: parseJson(row.payload), updatedAt: row.updated_at,
  }
}

export class InboxStore {
  constructor(db) {
    if (!db || typeof db.prepare !== "function") throw new Error("InboxStore 需要已打开的 node:sqlite DatabaseSync")
    this.db = db
    this.onChange = null
    this.db.exec(SCHEMA)
  }

  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const out = fn()
      this.db.exec("COMMIT")
      return out
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch {}
      throw error
    }
  }

  insert(event, now) {
    const at = iso(now)
    const uuid = randomUUID()
    const result = this.db.prepare(`
      INSERT INTO agent_inbox
        (uuid, kind, text, payload, dedupe_key, coalesce_key, status, reason,
         available_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid, event.kind, event.text || "", JSON.stringify(event.payload || {}), event.dedupeKey || "",
      event.coalesceKey || "", event.status || "pending", event.reason || "", event.availableAt || at,
      event.expiresAt || null, at, at
    )
    return Number(result.lastInsertRowid)
  }

  enqueue(event, now = new Date()) {
    const outcome = this.tx(() => this._enqueue(event, now))
    if (outcome.status === "pending") this.onChange?.(outcome)
    return outcome
  }

  // 调用方必须已持有 tx；Schedule 用它把「推进下次时间 + 写事件」放在同一事务。
  _enqueue({ kind, text = "", payload = {}, dedupeKey = "", coalesceKey = "", availableAt = "", expiresAt = "" }, now = new Date()) {
    if (!String(kind || "").trim()) throw new Error("Inbox 事件缺少 kind")
    const at = iso(now)
    if (dedupeKey) {
      const duplicate = this.db.prepare(`SELECT id FROM agent_inbox WHERE dedupe_key = ? AND status IN ${ACTIVE} LIMIT 1`).get(dedupeKey)
      if (duplicate) {
        const id = this.insert({ kind, text, payload, dedupeKey, coalesceKey, availableAt, expiresAt, status: "dropped", reason: "duplicate" }, at)
        return { id, status: "dropped", reason: "duplicate", duplicateOf: Number(duplicate.id) }
      }
    }
    let superseded = 0
    if (coalesceKey) {
      // processing 无法撤回，只替换尚未开始的 pending；处理中到达的新事件留给下一轮。
      const result = this.db.prepare(`
        UPDATE agent_inbox SET status = 'dropped', reason = 'superseded', updated_at = ?
        WHERE coalesce_key = ? AND status = 'pending'
      `).run(at, coalesceKey)
      superseded = Number(result.changes)
    }
    const id = this.insert({ kind, text, payload, dedupeKey, coalesceKey, availableAt: availableAt || at, expiresAt }, at)
    return { id, status: "pending", superseded }
  }

  get(id) {
    return eventOf(this.db.prepare("SELECT * FROM agent_inbox WHERE id = ?").get(id))
  }

  list({ limit = 100, offset = 0, status = "" } = {}) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 100))
    const skip = Math.max(0, Math.floor(Number(offset) || 0))
    const rows = status
      ? this.db.prepare("SELECT * FROM agent_inbox WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(status, n, skip)
      : this.db.prepare("SELECT * FROM agent_inbox ORDER BY id DESC LIMIT ? OFFSET ?").all(n, skip)
    return rows.map(eventOf)
  }

  count({ status = "" } = {}) {
    const row = status
      ? this.db.prepare("SELECT COUNT(*) AS count FROM agent_inbox WHERE status = ?").get(status)
      : this.db.prepare("SELECT COUNT(*) AS count FROM agent_inbox").get()
    return Number(row.count)
  }

  counts() {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM agent_inbox GROUP BY status").all()
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))
  }

  pendingCount(now = new Date()) {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM agent_inbox WHERE status = 'pending' AND available_at <= ?").get(iso(now)).count)
  }

  claimBatch(now = new Date(), { limit = 100, leaseMs = 900000 } = {}) {
    const at = iso(now)
    const runId = randomUUID()
    return this.tx(() => {
      this.db.prepare(`
        UPDATE agent_inbox SET status = 'pending', run_id = '', lease_until = NULL, updated_at = ?
        WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
      `).run(at, at)
      this.db.prepare(`
        UPDATE agent_inbox SET status = 'dropped', reason = 'expired', updated_at = ?
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(at, at)
      const rows = this.db.prepare(`
        SELECT id FROM agent_inbox WHERE status = 'pending' AND available_at <= ? ORDER BY id LIMIT ?
      `).all(at, Math.max(1, Math.min(500, Number(limit) || 100)))
      if (!rows.length) return []
      const ids = rows.map((row) => Number(row.id))
      const placeholders = ids.map(() => "?").join(",")
      this.db.prepare(`
        UPDATE agent_inbox SET status = 'processing', run_id = ?, attempts = attempts + 1,
          lease_until = ?, updated_at = ? WHERE id IN (${placeholders})
      `).run(runId, new Date(new Date(at).getTime() + leaseMs).toISOString(), at, ...ids)
      return this.db.prepare(`SELECT * FROM agent_inbox WHERE id IN (${placeholders}) ORDER BY id`).all(...ids).map(eventOf)
    })
  }

  complete(ids, now = new Date()) {
    if (!ids.length) return
    const placeholders = ids.map(() => "?").join(",")
    this.db.prepare(`UPDATE agent_inbox SET status = 'done', lease_until = NULL, last_error = '', updated_at = ? WHERE id IN (${placeholders})`)
      .run(iso(now), ...ids)
  }

  fail(ids, error, now = new Date(), retryMs = 30000) {
    if (!ids.length) return
    const at = new Date(iso(now))
    const placeholders = ids.map(() => "?").join(",")
    this.db.prepare(`
      UPDATE agent_inbox SET status = 'pending', available_at = ?, lease_until = NULL,
        run_id = '', last_error = ?, updated_at = ? WHERE id IN (${placeholders})
    `).run(new Date(at.getTime() + Math.max(0, retryMs)).toISOString(), String(error?.message || error), at.toISOString(), ...ids)
  }

  schedules() {
    return this.db.prepare("SELECT * FROM agent_schedules ORDER BY id").all().map(scheduleOf)
  }
}

export class ScheduleRunner {
  constructor({ store, allow = () => true, onChange = null, onError = null }) {
    this.store = store
    this.allow = allow
    this.onChange = onChange
    this.onError = onError
    this.timer = null
    this.closed = false
  }

  sync(definitions, now = new Date()) {
    const at = iso(now)
    this.store.tx(() => {
      for (const definition of definitions) {
        const previous = this.store.db.prepare("SELECT * FROM agent_schedules WHERE id = ?").get(definition.id)
        const enabled = definition.enabled === true
        let nextAt = enabled ? previous?.next_at || at : null
        if (enabled && (!previous || previous.cron !== definition.cron)) nextAt = at
        this.store.db.prepare(`
          INSERT INTO agent_schedules (id, kind, cron, enabled, next_at, payload, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, cron = excluded.cron,
            enabled = excluded.enabled, next_at = excluded.next_at, payload = excluded.payload, updated_at = excluded.updated_at
        `).run(definition.id, definition.kind, definition.cron, enabled ? 1 : 0, nextAt,
          JSON.stringify(definition.payload || {}), at)
      }
    })
    this.onChange?.(this.store.schedules())
    return this.store.schedules()
  }

  tick(now = new Date()) {
    const at = iso(now)
    const fired = []
    const due = this.store.tx(() => {
      const rows = this.store.db.prepare("SELECT * FROM agent_schedules WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at, id").all(at)
      for (const row of rows) {
        const schedule = scheduleOf(row)
        const next = nextCronTime(row.cron, new Date(at))
        this.store.db.prepare("UPDATE agent_schedules SET next_at = ?, updated_at = ? WHERE id = ?")
          .run(next ? next.toISOString() : null, at, row.id)
        if (!this.allow(schedule)) continue
        const event = this.store._enqueue({
          kind: schedule.kind,
          payload: { ...schedule.payload, scheduleId: schedule.id, dueAt: schedule.nextAt },
          dedupeKey: `schedule:${schedule.id}:${schedule.nextAt}`,
          coalesceKey: `schedule:${schedule.id}`,
          expiresAt: next ? next.toISOString() : "",
        }, now)
        fired.push({ ...event, kind: schedule.kind })
      }
      return rows.map(scheduleOf)
    })
    // 同一批 Schedule 全部落库后只唤醒一次，让 Worker 能合并消费。
    if (fired.some((event) => event.status === "pending")) this.store.onChange?.({ batch: fired })
    if (due.length) this.onChange?.(this.store.schedules())
    return fired
  }

  start(intervalMs = 1000) {
    this.closed = false
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      try { this.tick() } catch (error) { this.onError?.(error) }
    }, Math.max(100, Number(intervalMs) || 1000))
    this.timer.unref?.()
  }

  stop() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export class AgentWorker {
  constructor({ store, handlers, log = () => {}, pollMs = 1000, retryMs = 30000, leaseMs = 900000 }) {
    this.store = store
    this.handlers = handlers
    this.log = log
    this.pollMs = pollMs
    this.retryMs = retryMs
    this.leaseMs = leaseMs
    this.running = false
    this.again = false
    this.closed = false
    this.timer = null
    this.runPromise = null
    this.lastResult = null
    this.runCount = 0
  }

  start() {
    this.closed = false
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.wake(), Math.max(100, Number(this.pollMs) || 1000))
    this.timer.unref?.()
    this.wake()
  }

  wake() {
    if (this.closed) return
    if (this.running) {
      this.again = true
      return
    }
    if (this.runPromise) return
    this.runPromise = this.runOnce().catch((error) => {
      this.log(`Worker 异常：${error.message}`)
      return { ok: false, error: error.message }
    }).finally(() => {
      this.runPromise = null
      if (!this.closed && (this.again || this.store.pendingCount() > 0)) {
        this.again = false
        this.wake()
      }
    })
  }

  async idle() {
    while (this.runPromise || this.running) {
      if (this.runPromise) await this.runPromise
      else await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  async stop() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.idle()
  }

  async runOnce(now = new Date()) {
    if (this.running) return { ok: true, skipped: "busy" }
    this.running = true
    try {
      const events = this.store.claimBatch(now, { leaseMs: this.leaseMs })
      if (!events.length) {
        const out = { ok: true, claimed: 0, dropped: this.store.counts().dropped || 0 }
        this.lastResult = out
        return out
      }
      const routerEvents = events.filter((event) => ["router", "router.notice", "inspector", "inspector.notice"].includes(event.kind))
      const groups = new Map()
      for (const event of events.filter((event) => !routerEvents.includes(event))) {
        // 任务与邮件按条独立完成：不同事件可能属于不同 Agent，一条失败不能把已送达的另一条重投。
        const groupKey = ["task.update", "mail.reply"].includes(event.kind) ? `${event.kind}:${event.id}` : event.kind
        if (!groups.has(groupKey)) groups.set(groupKey, { kind: event.kind, batch: [] })
        groups.get(groupKey).batch.push(event)
      }
      if (routerEvents.length) groups.set("router", { kind: "router", batch: routerEvents })
      const errors = []
      let completed = 0
      for (const { kind, batch } of groups.values()) {
        const ids = batch.map((event) => event.id)
        try {
          const handler = kind === "router" ? this.handlers.router ?? this.handlers.inspector : this.handlers[kind]
          if (typeof handler !== "function") throw new Error(`Worker 没有 ${kind} 处理器`)
          const input = kind === "router"
            ? {
                events: batch,
                scheduled: batch.some((event) => ["router", "inspector"].includes(event.kind)),
                notices: batch.filter((event) => ["router.notice", "inspector.notice"].includes(event.kind)).map((event) => event.text).filter(Boolean),
              }
            : kind === "mail.reply" ? batch[0] : batch
          const result = await handler(input)
          if (result?.ok === false) throw new Error(result.error || `${kind} 处理失败`)
          this.store.complete(ids, now)
          completed += ids.length
        } catch (error) {
          this.store.fail(ids, error, now, this.retryMs)
          errors.push(`${kind}: ${error.message}`)
          this.log(`Worker ${kind} 处理失败，事件已放回 Inbox：${error.message}`)
        }
      }
      this.runCount++
      const out = { ok: errors.length === 0, claimed: events.length, completed, errors }
      this.lastResult = out
      return out
    } finally {
      this.running = false
    }
  }
}
