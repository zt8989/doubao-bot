// Always-on 原语：独立 SQLite Outbox → 单 Dispatcher → 外部通道。
// 调用方只持久化外发意图；Dispatcher 在同进程被直接唤醒，轮询负责漏唤醒与重启恢复。
import { randomUUID } from "node:crypto"

const iso = (value = new Date()) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_outbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid          TEXT NOT NULL UNIQUE,
    channel       TEXT NOT NULL,
    payload       TEXT NOT NULL DEFAULT '{}',
    dedupe_key    TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    available_at  TEXT NOT NULL,
    lease_until   TEXT,
    run_id        TEXT NOT NULL DEFAULT '',
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 8,
    last_error    TEXT NOT NULL DEFAULT '',
    result        TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    sent_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_outbox_ready ON agent_outbox(status, available_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_outbox_dedupe
    ON agent_outbox(dedupe_key) WHERE dedupe_key <> '';
`

function parseJson(text) {
  try { return JSON.parse(text || "{}") } catch { return {} }
}

function messageOf(row) {
  if (!row) return null
  return {
    id: Number(row.id), uuid: row.uuid, channel: row.channel, payload: parseJson(row.payload),
    dedupeKey: row.dedupe_key, status: row.status, availableAt: row.available_at,
    leaseUntil: row.lease_until || "", runId: row.run_id, attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts), lastError: row.last_error, result: parseJson(row.result),
    createdAt: row.created_at, updatedAt: row.updated_at, sentAt: row.sent_at || "",
  }
}

export class OutboxStore {
  constructor(db) {
    if (!db || typeof db.prepare !== "function") throw new Error("OutboxStore 需要已打开的 node:sqlite DatabaseSync")
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

  enqueue({ channel, payload = {}, dedupeKey = "", availableAt = "", maxAttempts = 8 }, now = new Date()) {
    if (!String(channel || "").trim()) throw new Error("Outbox 消息缺少 channel")
    const at = iso(now)
    const outcome = this.tx(() => {
      if (dedupeKey) {
        const existing = this.db.prepare("SELECT id, uuid, status FROM agent_outbox WHERE dedupe_key = ?").get(dedupeKey)
        if (existing) return { id: Number(existing.id), uuid: existing.uuid, status: existing.status, duplicate: true }
      }
      const uuid = randomUUID()
      const result = this.db.prepare(`
        INSERT INTO agent_outbox
          (uuid, channel, payload, dedupe_key, status, available_at, max_attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(uuid, channel, JSON.stringify(payload), dedupeKey, availableAt || at,
        Math.max(1, Number(maxAttempts) || 8), at, at)
      return { id: Number(result.lastInsertRowid), uuid, status: "pending", duplicate: false }
    })
    if (outcome.status === "pending" && !outcome.duplicate) this.onChange?.(outcome)
    return outcome
  }

  get(id) {
    return messageOf(this.db.prepare("SELECT * FROM agent_outbox WHERE id = ?").get(id))
  }

  list({ limit = 100, status = "", channel = "" } = {}) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 100))
    const where = []
    const args = []
    if (status) { where.push("status = ?"); args.push(status) }
    if (channel) { where.push("channel = ?"); args.push(channel) }
    const sql = `SELECT * FROM agent_outbox${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, n).map(messageOf)
  }

  counts() {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM agent_outbox GROUP BY status").all()
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))
  }

  pendingCount(now = new Date()) {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM agent_outbox WHERE status = 'pending' AND available_at <= ?").get(iso(now)).count)
  }

  claimBatch(now = new Date(), { limit = 50, leaseMs = 120000 } = {}) {
    const at = iso(now)
    const runId = randomUUID()
    return this.tx(() => {
      this.db.prepare(`
        UPDATE agent_outbox SET status = 'pending', run_id = '', lease_until = NULL, updated_at = ?
        WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
      `).run(at, at)
      const rows = this.db.prepare(`
        SELECT id FROM agent_outbox WHERE status = 'pending' AND available_at <= ? ORDER BY id LIMIT ?
      `).all(at, Math.max(1, Math.min(200, Number(limit) || 50)))
      if (!rows.length) return []
      const ids = rows.map((row) => Number(row.id))
      const placeholders = ids.map(() => "?").join(",")
      this.db.prepare(`
        UPDATE agent_outbox SET status = 'processing', run_id = ?, attempts = attempts + 1,
          lease_until = ?, updated_at = ? WHERE id IN (${placeholders})
      `).run(runId, new Date(new Date(at).getTime() + leaseMs).toISOString(), at, ...ids)
      return this.db.prepare(`SELECT * FROM agent_outbox WHERE id IN (${placeholders}) ORDER BY id`).all(...ids).map(messageOf)
    })
  }

  complete(id, result, now = new Date()) {
    const at = iso(now)
    this.db.prepare(`
      UPDATE agent_outbox SET status = 'sent', lease_until = NULL, run_id = '', last_error = '',
        result = ?, sent_at = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(result ?? {}), at, at, id)
  }

  fail(id, error, now = new Date(), retryMs = 30000) {
    const at = new Date(iso(now))
    return this.tx(() => {
      const row = this.db.prepare("SELECT attempts, max_attempts FROM agent_outbox WHERE id = ?").get(id)
      if (!row) return { status: "missing" }
      const exhausted = Number(row.attempts) >= Number(row.max_attempts)
      const availableAt = exhausted ? at.toISOString() : new Date(at.getTime() + Math.max(0, retryMs)).toISOString()
      this.db.prepare(`
        UPDATE agent_outbox SET status = ?, available_at = ?, lease_until = NULL, run_id = '',
          last_error = ?, updated_at = ? WHERE id = ?
      `).run(exhausted ? "failed" : "pending", availableAt, String(error?.message || error), at.toISOString(), id)
      return { status: exhausted ? "failed" : "pending", availableAt }
    })
  }
}

export class OutboxDispatcher {
  constructor({ store, handlers, onSent = null, onFailed = null, log = () => {}, pollMs = 1000, retryMs = 30000, leaseMs = 120000 }) {
    this.store = store
    this.handlers = handlers
    this.onSent = onSent
    this.onFailed = onFailed
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
      this.log(`Dispatcher 异常：${error.message}`)
      return { ok: false, error: error.message }
    }).finally(() => {
      this.runPromise = null
      if (!this.closed && this.again) {
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
      const messages = this.store.claimBatch(now, { leaseMs: this.leaseMs })
      if (!messages.length) {
        const out = { ok: true, claimed: 0, counts: this.store.counts() }
        this.lastResult = out
        return out
      }
      const errors = []
      let sent = 0
      for (const event of messages) {
        try {
          const handler = this.handlers[event.channel]
          if (typeof handler !== "function") throw new Error(`Dispatcher 没有 ${event.channel} 通道`)
          const result = await handler(event)
          if (result?.ok === false) throw new Error(result.error || `${event.channel} 发送失败`)
          // 外部发送成功后先落 sent；本地回调失败绝不能让外部消息重发。
          this.store.complete(event.id, result, now)
          sent++
          try { await this.onSent?.(event, result) } catch (error) {
            this.log(`Outbox ${event.id} 发送后记账失败：${error.message}`)
          }
        } catch (error) {
          const outcome = this.store.fail(event.id, error, now, this.retryMs)
          errors.push(`${event.channel}:${event.id}: ${error.message}`)
          this.log(`Outbox ${event.id} 发送${outcome.status === "failed" ? "最终失败" : "失败，等待重试"}：${error.message}`)
          if (outcome.status === "failed") {
            try { await this.onFailed?.(event, error) } catch (callbackError) {
              this.log(`Outbox ${event.id} 失败记账异常：${callbackError.message}`)
            }
          }
        }
      }
      this.runCount++
      const out = { ok: errors.length === 0, claimed: messages.length, sent, errors }
      this.lastResult = out
      return out
    } finally {
      this.running = false
    }
  }
}
