// 控制台数据层：把账本快照进 SQLite，并按工单号去重。
// 唯一键 = "<owner>/<repo>#<number>"：同一张单反复同步只更新状态与 last_seen_at，
// first_seen_at 保留第一次发现时间，永远不会多出一行。
//
// 这个模块不负责 HTTP，只提供 ConsoleStore；HTTP 路由在 service.mjs 里挂。
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const pad = (n) => String(n).padStart(2, "0")

export function localDay(v) {
  const d = v instanceof Date ? v : new Date(v)
  if (!v || Number.isNaN(d.getTime())) return ""
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function clockOf(v) {
  const d = v instanceof Date ? v : new Date(v)
  if (!v || Number.isNaN(d.getTime())) return ""
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    key            TEXT PRIMARY KEY,          -- <owner>/<repo>#<number>
    repo           TEXT NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT,
    url            TEXT,
    state          TEXT,
    branch         TEXT,
    worktree       TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    note           TEXT,
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    last_update_at TEXT
  );

  CREATE TABLE IF NOT EXISTS prs (
    key            TEXT PRIMARY KEY,          -- <owner>/<repo>#<number>
    repo           TEXT NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT,
    author         TEXT,
    url            TEXT,
    skipped        TEXT,
    state          TEXT NOT NULL DEFAULT 'pending',   -- pending | notified | skipped
    notified_to    TEXT,
    notified_at    TEXT,
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    tasks       INTEGER NOT NULL DEFAULT 0,
    prs         INTEGER NOT NULL DEFAULT 0,
    new_tasks   INTEGER NOT NULL DEFAULT 0,
    new_prs     INTEGER NOT NULL DEFAULT 0,
    pending     INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_last ON tasks(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_prs_last   ON prs(last_seen_at);
`

export class ConsoleStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)

    this.q = {
      upsertTask: this.db.prepare(`
        INSERT INTO tasks (key, repo, number, title, url, state, branch, worktree, attempts, note,
                           first_seen_at, last_seen_at, last_update_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          title          = excluded.title,
          url            = excluded.url,
          state          = excluded.state,
          branch         = excluded.branch,
          worktree       = excluded.worktree,
          attempts       = excluded.attempts,
          note           = excluded.note,
          last_seen_at   = excluded.last_seen_at,
          last_update_at = excluded.last_update_at
      `),
      upsertPr: this.db.prepare(`
        INSERT INTO prs (key, repo, number, title, author, url, skipped, state,
                         notified_to, notified_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          title        = excluded.title,
          author       = excluded.author,
          url          = excluded.url,
          skipped      = excluded.skipped,
          state        = excluded.state,
          notified_to  = excluded.notified_to,
          notified_at  = excluded.notified_at,
          last_seen_at = excluded.last_seen_at
      `),
      insertPoll: this.db.prepare(`
        INSERT INTO polls (at, tasks, prs, new_tasks, new_prs, pending) VALUES (?, ?, ?, ?, ?, ?)
      `),
      countTasks: this.db.prepare("SELECT COUNT(*) AS c FROM tasks"),
      countPrs: this.db.prepare("SELECT COUNT(*) AS c FROM prs"),
      countPolls: this.db.prepare("SELECT COUNT(*) AS c FROM polls"),
      countPending: this.db.prepare("SELECT COUNT(*) AS c FROM prs WHERE state = 'pending'"),
      allTasks: this.db.prepare("SELECT * FROM tasks ORDER BY last_seen_at DESC"),
      allPrs: this.db.prepare("SELECT * FROM prs ORDER BY last_seen_at DESC"),
      recentPolls: this.db.prepare(
        "SELECT id, at, tasks, prs, new_tasks, new_prs, pending FROM polls ORDER BY id DESC LIMIT 10"
      ),
    }
  }

  /** 账本 → SQLite。只 upsert，不写 polls；返回本轮新增条数。 */
  sync(book) {
    const at = new Date().toISOString()
    const beforeTasks = Number(this.q.countTasks.get().c)
    const beforePrs = Number(this.q.countPrs.get().c)

    for (const [key, it] of Object.entries(book?.issues || {})) {
      const [repo, number] = key.split("#")
      if (!repo || !number) continue
      this.q.upsertTask.run(
        key,
        repo,
        Number(number) || Number(it.issue) || 0,
        it.title || "",
        it.url || "",
        it.state || "unknown",
        it.branch || "",
        it.worktree || "",
        Number(it.attempts) || 0,
        it.note || "",
        it.updatedAt || at,
        at,
        it.updatedAt || at
      )
    }

    for (const [key, p] of Object.entries(book?.prSeen || {})) {
      const [repo, number] = key.split("#")
      if (!repo || !number) continue
      const state = p.skipped ? "skipped" : p.notifiedAt ? "notified" : "pending"
      this.q.upsertPr.run(
        key,
        p.repo || repo,
        Number(p.number) || Number(number) || 0,
        p.title || "",
        p.author || "",
        p.url || "",
        p.skipped || "",
        state,
        p.notifiedTo || "",
        p.notifiedAt || "",
        p.seenAt || at,
        at
      )
    }

    const totalTasks = Number(this.q.countTasks.get().c)
    const totalPrs = Number(this.q.countPrs.get().c)
    return {
      at,
      newTasks: totalTasks - beforeTasks,
      newPrs: totalPrs - beforePrs,
      totalTasks,
      totalPrs,
    }
  }

  /** 记一轮扫描：当天口径的行数 + 本轮新增。 */
  recordPoll(sync = {}) {
    const now = new Date()
    const today = localDay(now)
    const tasks = this.q.allTasks.all().filter((r) => localDay(r.last_seen_at) === today)
    const prs = this.q.allPrs.all().filter((r) => localDay(r.last_seen_at) === today)
    const pending = prs.filter((r) => r.state === "pending").length

    this.q.insertPoll.run(
      now.toISOString(),
      tasks.length,
      prs.length,
      Number(sync.newTasks) || 0,
      Number(sync.newPrs) || 0,
      pending
    )
    return { at: now.toISOString(), tasks: tasks.length, prs: prs.length, pending }
  }

  /** 当天视图（给 HTTP /api/snapshot）。 */
  snapshot({ book, cfg, pr = {}, service = {} } = {}) {
    const now = new Date()
    const today = localDay(now)

    const tasks = this.q.allTasks
      .all()
      .filter((r) => localDay(r.last_seen_at) === today)
      .map((r) => ({
        key: r.key,
        repo: r.repo,
        number: r.number,
        title: r.title,
        url: r.url,
        state: r.state,
        branch: r.branch,
        worktree: r.worktree,
        attempts: r.attempts,
        note: r.note,
        updatedAt: r.last_update_at,
        updatedAtClock: clockOf(r.last_update_at),
        firstSeenClock: clockOf(r.first_seen_at),
      }))

    const prs = this.q.allPrs
      .all()
      .filter((r) => localDay(r.last_seen_at) === today)
      .map((r) => ({
        key: r.key,
        repo: r.repo,
        number: r.number,
        title: r.title,
        url: r.url,
        author: r.author,
        skipped: r.skipped,
        state: r.state,
        notifiedTo: r.notified_to,
        notifiedAt: r.notified_at,
        notifiedAtClock: clockOf(r.notified_at),
        seenAt: r.first_seen_at,
        seenAtClock: clockOf(r.first_seen_at),
        pending: r.state === "pending",
      }))

    const totalTasks = Number(this.q.countTasks.get().c)
    const totalPrs = Number(this.q.countPrs.get().c)
    const totalPolls = Number(this.q.countPolls.get().c)
    const prCfg = cfg?.prWatch || {}

    return {
      generatedAt: now.toISOString(),
      generatedAtClock: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      today,
      service: {
        alive: true,
        pid: service.pid ?? process.pid,
        uptimeMs: service.uptimeMs ?? null,
        port: service.port ?? null,
        http: service.http ?? "",
        intervalSeconds: prCfg.intervalSeconds ?? null,
        enabled: prCfg.enabled === true,
      },
      prWatch: {
        enabled: prCfg.enabled === true,
        intervalSeconds: prCfg.intervalSeconds ?? null,
        state: prCfg.state || "open",
        ignoreAuthors: prCfg.ignoreAuthors || [],
        target: pr?.target || "",
        lastPollAt: pr?.lastPollAt ?? null,
        lastPollAtClock: clockOf(pr?.lastPollAt),
        pollCount: pr?.pollCount ?? 0,
        notifiedCount: pr?.notifiedCount ?? 0,
        pending: pr?.pending ?? 0,
      },
      repos: (cfg?.repos || []).map((r) => r.name).filter(Boolean),
      tasks,
      prs,
      stats: {
        tasks: tasks.length,
        working: tasks.filter((t) => t.state === "working").length,
        prOpen: tasks.filter((t) => t.state === "pr-open").length,
        prs: prs.length,
        pending: prs.filter((p) => p.pending).length,
        notified: prs.filter((p) => p.state === "notified").length,
        skipped: prs.filter((p) => p.state === "skipped").length,
        newPrs: pr?.lastNewPrs ?? 0,
        historyTasks: totalTasks,
        historyPrs: totalPrs,
      },
      storage: {
        driver: "sqlite",
        file: this.file,
        uniqueKey: "<owner>/<repo>#<number>",
        rows: { tasks: totalTasks, prs: totalPrs, polls: totalPolls },
        pendingAll: Number(this.q.countPending.get().c),
      },
      recentPolls: this.q.recentPolls.all().map((p) => ({
        id: p.id,
        atClock: clockOf(p.at),
        tasks: p.tasks,
        prs: p.prs,
        newTasks: p.new_tasks,
        newPrs: p.new_prs,
        pending: p.pending,
      })),
    }
  }

  /** 最近几轮扫描记录。 */
  polls(limit = 10) {
    return this.q.recentPolls
      .all()
      .slice(0, Math.max(0, Number(limit) || 10))
      .map((p) => ({
        id: p.id,
        at: p.at,
        atClock: clockOf(p.at),
        tasks: p.tasks,
        prs: p.prs,
        newTasks: p.new_tasks,
        newPrs: p.new_prs,
        pending: p.pending,
      }))
  }

  close() {
    try {
      this.db.close()
    } catch {}
  }
}
