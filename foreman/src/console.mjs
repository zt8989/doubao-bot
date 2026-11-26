// 控制台数据层：把账本快照进 SQLite，并按工单号去重。
// 唯一键 = "<owner>/<repo>#<number>"：同一张单反复同步只更新状态与 last_seen_at，
// first_seen_at 保留第一次发现时间，永远不会多出一行。
//
// 这个模块不负责 HTTP，只提供 ConsoleStore；HTTP 路由在 service.mjs 里挂。
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const pad = (n) => String(n).padStart(2, "0")

// 今日任务先按状态分组：进行中优先，待处理状态居中，完成与未知状态最后。
const TASK_STATE_ORDER = ["working", "planned", "pr-open", "needs-human", "blocked", "escalated", "failed", "reset", "done", "unknown"]
const taskStateRank = (state) => {
  const rank = TASK_STATE_ORDER.indexOf(state)
  return rank < 0 ? TASK_STATE_ORDER.length : rank
}

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
    last_seen_at   TEXT NOT NULL,   -- 最后一次被同步看到，每轮都会刷新
    last_update_at TEXT,
    last_change_at TEXT             -- 最后一次真实变化（账本 updatedAt），「今日」口径用它
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
    last_seen_at   TEXT NOT NULL,   -- 最后一次被同步看到，每轮都会刷新
    last_change_at TEXT             -- 最后一次真实变化（新发现/状态或通知变化），「今日」口径用它
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

  -- 事件流水：每张单/PR 的每一次真实变化留一条，历史视图与单条时间线都靠它。
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    day        TEXT NOT NULL,
    kind       TEXT NOT NULL,                   -- task_new/task_state/task_attempt/pr_new/pr_state/pr_open/pr_merge/issue_comment/issue_close
    key        TEXT NOT NULL DEFAULT '',        -- <owner>/<repo>#<number>
    repo       TEXT NOT NULL DEFAULT '',
    number     INTEGER NOT NULL DEFAULT 0,
    from_state TEXT NOT NULL DEFAULT '',
    to_state   TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    agent      TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_events_at  ON events(at);
  CREATE INDEX IF NOT EXISTS idx_events_key ON events(key);

  -- 操作日志：派单、合并、清理等长动作先写 running，结束时更新结果。
  CREATE TABLE IF NOT EXISTS operations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    title       TEXT NOT NULL,
    key         TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'running', -- running | success | failed | interrupted
    detail      TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_operations_started ON operations(started_at);
  CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);

  CREATE INDEX IF NOT EXISTS idx_tasks_last ON tasks(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_prs_last   ON prs(last_seen_at);
`

export class ConsoleStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    // WAL + busy_timeout：控制台轮询、Worker/Dispatcher、外部 sqlite3 查询共用一个库，
    // 回滚日志模式下读会挡写，实跑出过 database is locked（Worker/Dispatcher 直接抛异常）。
    // WAL 模式写在库里持久生效；busy_timeout 是连接级的，每次打开都要设。
    this.db.exec("PRAGMA journal_mode=WAL")
    this.db.exec("PRAGMA busy_timeout=3000")
    this.db.exec(SCHEMA)
    // 老库补列：接单派给了哪个会话，统计要靠它。
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN agent TEXT DEFAULT ''") } catch {}
    // 老库补列：last_seen_at 每轮同步都会刷新，不能当「今天有没有变化」用，
    // 单独的 last_change_at 只记真实变化（账本 updatedAt / 新发现 / 状态变化）。
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN last_change_at TEXT") } catch {}
    try { this.db.exec("ALTER TABLE prs ADD COLUMN last_change_at TEXT") } catch {}
    // 老库首次补列后回填一次，历史行的真实变化时间就是原来的 last_update_at / first_seen_at。
    try {
      this.db.exec("UPDATE tasks SET last_change_at = COALESCE(last_update_at, first_seen_at) WHERE last_change_at IS NULL")
      this.db.exec("UPDATE prs SET last_change_at = COALESCE(NULLIF(notified_at, ''), first_seen_at) WHERE last_change_at IS NULL")
    } catch {}

    this.q = {
      upsertTask: this.db.prepare(`
        INSERT INTO tasks (key, repo, number, title, url, state, branch, worktree, attempts, note, agent,
                           first_seen_at, last_seen_at, last_update_at, last_change_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          title          = excluded.title,
          url            = excluded.url,
          state          = excluded.state,
          branch         = excluded.branch,
          worktree       = excluded.worktree,
          attempts       = excluded.attempts,
          note           = excluded.note,
          agent          = excluded.agent,
          last_seen_at   = excluded.last_seen_at,
          last_update_at = excluded.last_update_at,
          last_change_at = COALESCE(excluded.last_change_at, tasks.last_change_at)
      `),
      upsertPr: this.db.prepare(`
        INSERT INTO prs (key, repo, number, title, author, url, skipped, state,
                         notified_to, notified_at, first_seen_at, last_seen_at, last_change_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          title          = excluded.title,
          author         = excluded.author,
          url            = excluded.url,
          skipped        = excluded.skipped,
          state          = excluded.state,
          notified_to    = excluded.notified_to,
          notified_at    = excluded.notified_at,
          last_seen_at   = excluded.last_seen_at,
          last_change_at = COALESCE(excluded.last_change_at, prs.last_change_at)
      `),
      insertPoll: this.db.prepare(`
        INSERT INTO polls (at, tasks, prs, new_tasks, new_prs, pending) VALUES (?, ?, ?, ?, ?, ?)
      `),
      countTasks: this.db.prepare("SELECT COUNT(*) AS c FROM tasks"),
      countPrs: this.db.prepare("SELECT COUNT(*) AS c FROM prs"),
      countPolls: this.db.prepare("SELECT COUNT(*) AS c FROM polls"),
      countPending: this.db.prepare("SELECT COUNT(*) AS c FROM prs WHERE state = 'pending'"),
      allTasks: this.db.prepare("SELECT * FROM tasks ORDER BY COALESCE(last_change_at, last_update_at) DESC, number DESC"),
      allPrs: this.db.prepare("SELECT * FROM prs ORDER BY COALESCE(last_change_at, first_seen_at) DESC, number DESC"),
      recentPolls: this.db.prepare(
        "SELECT id, at, tasks, prs, new_tasks, new_prs, pending FROM polls ORDER BY id DESC LIMIT 10"
      ),
      getTask: this.db.prepare("SELECT * FROM tasks WHERE key = ?"),
      getPr: this.db.prepare("SELECT * FROM prs WHERE key = ?"),
      insertEvent: this.db.prepare(`
        INSERT INTO events (at, day, kind, key, repo, number, from_state, to_state, detail, agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      eventsSince: this.db.prepare("SELECT * FROM events WHERE at >= ? ORDER BY at ASC, id ASC"),
      eventsOnDay: this.db.prepare("SELECT * FROM events WHERE day = ? ORDER BY at ASC, id ASC"),
      eventsUpToDay: this.db.prepare("SELECT * FROM events WHERE day <= ? ORDER BY at ASC, id ASC"),
      eventsForKey: this.db.prepare("SELECT * FROM events WHERE key = ? ORDER BY at ASC, id ASC"),
      countEvents: this.db.prepare("SELECT COUNT(*) AS c FROM events"),
      dayCounts: this.db.prepare(
        "SELECT day, COUNT(*) AS c FROM events GROUP BY day ORDER BY day DESC LIMIT 60"
      ),
      insertOperation: this.db.prepare(`
        INSERT INTO operations (action, title, key, status, detail, started_at, finished_at)
        VALUES (?, ?, ?, 'running', ?, ?, '')
      `),
      finishOperation: this.db.prepare(
        "UPDATE operations SET status = ?, detail = ?, finished_at = ? WHERE id = ?"
      ),
      getOperation: this.db.prepare("SELECT * FROM operations WHERE id = ?"),
      recentOperations: this.db.prepare("SELECT * FROM operations ORDER BY id DESC LIMIT ?"),
      runningOperations: this.db.prepare("SELECT * FROM operations WHERE status = 'running' ORDER BY id ASC"),
    }

    this.backfillEvents()
  }

  operationStart({ action, title, key = "", detail = "", at = new Date().toISOString() }) {
    const r = this.q.insertOperation.run(String(action), String(title), String(key), String(detail), String(at))
    return Number(r.lastInsertRowid)
  }

  operationFinish(id, status, detail = "", at = new Date().toISOString()) {
    this.q.finishOperation.run(String(status), String(detail).slice(0, 2000), String(at), Number(id))
  }

  operationGet(id) {
    return this.q.getOperation.get(Number(id))
  }

  // 服务重启后，上次的 running 不可能还在继续，标成中断而不是永远显示「正在…」。
  recoverOperations() {
    for (const row of this.q.runningOperations.all()) {
      this.operationFinish(row.id, "interrupted", row.detail || "服务重启，操作中断")
    }
  }

  operations({ limit = 100, status = "", action = "" } = {}) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500)
    return this.q.recentOperations.all(Math.min(n * 3, 500))
      .filter((r) => (!status || r.status === status) && (!action || r.action === action))
      .slice(0, n)
      .map((r) => ({
        ...r,
        startedAtClock: clockOf(r.started_at),
        finishedAtClock: clockOf(r.finished_at),
        day: localDay(r.started_at),
      }))
  }

  /**
   * 老库第一次升级（事件表还空着）：拿已有的单/PR 补一条「接到」，
   * 有状态的再补一条「状态」，历史不至于一片空白。只跑一次。
   */
  backfillEvents() {
    try {
      if (Number(this.q.countEvents.get().c) > 0) return
      const nowIso = new Date().toISOString()
      for (const t of this.q.allTasks.all()) {
        const first = t.first_seen_at || nowIso
        this.event({ at: first, kind: "task_new", key: t.key, repo: t.repo, number: t.number, detail: t.title || "", agent: t.agent || "" })
        if (t.state) {
          this.event({
            at: t.last_update_at || first, kind: "task_state", key: t.key, repo: t.repo,
            number: t.number, to: t.state, detail: "（回填）", agent: t.agent || "",
          })
        }
      }
      for (const p of this.q.allPrs.all()) {
        this.event({
          at: p.notified_at || p.first_seen_at || nowIso, kind: "pr_new", key: p.key, repo: p.repo,
          number: p.number, to: p.state || "", detail: p.title || "",
        })
      }
    } catch {}
  }

  /** 账本 → SQLite。只 upsert，不写 polls；返回本轮新增条数。 */
  sync(book) {
    const at = new Date().toISOString()
    const beforeTasks = Number(this.q.countTasks.get().c)
    const beforePrs = Number(this.q.countPrs.get().c)

    for (const [key, it] of Object.entries(book?.issues || {})) {
      const [repo, number] = key.split("#")
      if (!repo || !number) continue
      const prev = this.q.getTask.get(key)
      if (!prev) {
        this.event({
          at, kind: "task_new", key, repo,
          number: Number(number) || Number(it.issue) || 0,
          to: it.state || "", detail: it.title || "", agent: it.agent || "",
        })
      } else {
        if (String(prev.state || "") !== String(it.state || "")) {
          this.event({
            at, kind: "task_state", key, repo,
            number: Number(number) || Number(it.issue) || 0,
            from: prev.state || "", to: it.state || "",
            detail: it.note || "", agent: it.agent || "",
          })
        }
        if (Number(it.attempts) > Number(prev.attempts || 0)) {
          this.event({
            at, kind: "task_attempt", key, repo,
            number: Number(number) || Number(it.issue) || 0,
            to: it.state || "",
            detail: `第 ${Number(it.attempts)} 次尝试`, agent: it.agent || "",
          })
        }
      }
      // 真实变化时间：账本有 updatedAt 就用它；账本没给但状态变了、或是新单，才用本轮时间。
      // 都没变就传 null，交给 upsert 的 COALESCE 保留旧值——这样「今日」不会被每轮同步刷成今天。
      const changed = prev
        ? String(prev.state || "") !== String(it.state || "") || Number(it.attempts) > Number(prev.attempts || 0)
        : true
      const changeAt = it.updatedAt || (changed ? at : null)
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
        it.agent || "",
        it.updatedAt || at,
        at,
        it.updatedAt || at,
        changeAt
      )
    }

    for (const [key, p] of Object.entries(book?.prSeen || {})) {
      const [repo, number] = key.split("#")
      if (!repo || !number) continue
      const state = p.skipped ? "skipped" : p.notifiedAt || p.notifiedTo ? "notified" : "pending"
      const prev = this.q.getPr.get(key)
      if (!prev) {
        this.event({
          at, kind: "pr_new", key, repo,
          number: Number(p.number) || Number(number) || 0,
          to: state, detail: p.title || "",
        })
      } else if (String(prev.state || "") !== state) {
        this.event({
          at, kind: "pr_state", key, repo,
          number: Number(p.number) || Number(number) || 0,
          from: prev.state || "", to: state,
          detail: p.skipped ? `跳过：${p.skipped}` : p.notifiedTo ? `已通知 ${p.notifiedTo}` : "",
        })
      }
      // 同任务口径：新 PR、状态变了、或刚发过通知才算变化，其余保留旧值。
      const prChangeAt = !prev || String(prev.state || "") !== state
        ? (p.notifiedAt || at)
        : (String(prev.notified_at || "") !== String(p.notifiedAt || "") ? (p.notifiedAt || at) : null)
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
        at,
        prChangeAt
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

  /** 记一条事件（历史视图的原料）。at 缺省取当前时刻。 */
  event({ at = new Date().toISOString(), kind, key = "", repo = "", number = 0, from = "", to = "", detail = "", agent = "" } = {}) {
    if (!kind) return null
    const day = localDay(at)
    const row = {
      at, day, kind, key, repo,
      number: Number(number) || 0,
      from: from || "", to: to || "", detail: detail || "", agent: agent || "",
    }
    try {
      this.q.insertEvent.run(row.at, row.day, row.kind, row.key, row.repo, row.number, row.from, row.to, row.detail, row.agent)
    } catch {}
    return row
  }

  /**
   * 历史：按天分组的事件时间线（新的在前）。
   * days<=0 表示全部；day="YYYY-MM-DD" 只看那一天（优先于 days）；
   * repo 过滤 <owner>/<repo>；key 过滤单条（<owner>/<repo>#<number>）。
   */
  history({ days = 7, repo = "", key = "", day = "" } = {}) {
    const n = Number(days)
    const span = Number.isFinite(n) && n > 0 ? n : 0
    const since = span ? new Date(Date.now() - span * 86400000).toISOString() : ""
    const dayPick = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? String(day) : ""
    let rows = dayPick
      ? this.q.eventsOnDay.all(dayPick)
      : key
      ? this.q.eventsForKey.all(key)
      : this.q.eventsSince.all(since || "0000")

    // 标题从当前行反查，事件本身只存 key，不重复存标题。
    const titles = new Map()
    for (const t of this.q.allTasks.all()) titles.set(t.key, t.title)
    for (const p of this.q.allPrs.all()) if (!titles.has(p.key)) titles.set(p.key, p.title)

    if (repo) rows = rows.filter((r) => r.repo === repo)

    const groups = new Map()
    for (const r of rows) {
      if (!groups.has(r.day)) groups.set(r.day, { day: r.day, count: 0, tasks: new Set(), prs: new Set(), items: [] })
      const g = groups.get(r.day)
      g.count += 1
      if (String(r.kind).startsWith("pr")) g.prs.add(r.key)
      else g.tasks.add(r.key)
      g.items.push({
        id: r.id,
        at: r.at,
        atClock: clockOf(r.at),
        kind: r.kind,
        key: r.key,
        repo: r.repo,
        number: r.number,
        title: titles.get(r.key) || "",
        from: r.from_state,
        to: r.to_state,
        detail: r.detail,
        agent: r.agent,
      })
    }

    const list = [...groups.values()]
      .map((g) => ({
        day: g.day,
        count: g.count,
        tasks: [...g.tasks].filter(Boolean),
        prs: [...g.prs].filter(Boolean),
        items: g.items.sort((a, b) => (a.at < b.at ? 1 : -1)),
      }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))

    return {
      generatedAt: new Date().toISOString(),
      days: span,
      day: dayPick,
      since,
      repo: repo || "",
      key: key || "",
      total: rows.length,
      eventsInDb: Number(this.q.countEvents.get().c),
      // 有记录的日期（最近 60 天里出现过的），给页面做「按日期快选」。
      availableDays: this.q.dayCounts.all().map((d) => ({ day: d.day, count: Number(d.c) })),
      groups: list,
    }
  }

  /** 记一轮扫描：当天口径的行数 + 本轮新增。 */
  recordPoll(sync = {}) {
    const now = new Date()
    const today = localDay(now)
    // 当天口径 = 当天真实有变化（last_change_at），不是「这轮同步看到过」（last_seen_at）。
    const tasks = this.q.allTasks.all().filter((r) => localDay(r.last_change_at || r.last_update_at) === today)
    const prs = this.q.allPrs.all().filter((r) => localDay(r.last_change_at || r.first_seen_at) === today)
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
  snapshot({ book, cfg, pr = {}, service = {}, day = "", runningSessions = null } = {}) {
    const now = new Date()
    const today = localDay(now)
    const target = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? String(day) : today
    const isToday = target === today

    const allTasks = this.q.allTasks.all()
    const allPrs = this.q.allPrs.all()

    // 看今天：按 last_change_at 取「当天真实有变化」的行——不能用 last_seen_at，
    // 那个字段每轮同步都会被刷成当前时间，会把账本里所有历史单都算进今天。
    // 回看某天：状态从事件流水回放到那天结束，列表只列「那天新建或有过变化」的条目。
    const stateAt = new Map()
    const touchedAt = new Map()
    const taskKeys = new Set()
    const prKeys = new Set()
    let taskRows
    let prRows
    if (isToday) {
      taskRows = allTasks.filter((r) => localDay(r.last_change_at || r.last_update_at) === today)
      prRows = allPrs.filter((r) => localDay(r.last_change_at || r.first_seen_at) === today)
    } else {
      for (const e of this.q.eventsUpToDay.all(target)) {
        if (e.to_state) stateAt.set(e.key, e.to_state)
        if (e.day === target) touchedAt.set(e.key, e.at)
        if (String(e.kind).startsWith("pr")) prKeys.add(e.key)
        else taskKeys.add(e.key)
      }
      taskRows = allTasks.filter((r) => touchedAt.has(r.key) || localDay(r.first_seen_at) === target)
      prRows = allPrs.filter((r) => touchedAt.has(r.key) || localDay(r.first_seen_at) === target)
    }

    // 有些行的 url 是空的（老数据/适配器没回），这里按仓库拼一发，保证页面上的号总能点开。
    const base = String((cfg && cfg.gitea && cfg.gitea.baseUrl) || "http://106.54.199.229:3000").replace(/\/+$/, "")
    const taskUrl = (r) => r.url || (r.repo ? `${base}/${r.repo}/issues/${r.number}` : "")
    const prUrl = (r) => r.url || (r.repo ? `${base}/${r.repo}/pulls/${r.number}` : "")

    const pastOf = (r) =>
      isToday
        ? null
        : { state: stateAt.get(r.key) || r.state, at: touchedAt.get(r.key) || r.last_update_at }

    const tasks = taskRows.map((r) => {
      const past = pastOf(r)
      const state = past ? past.state : r.state
      const updatedAt = past ? past.at : (r.last_change_at || r.last_update_at)
      const convId = String(book?.issues?.[r.key]?.agentConvId ?? "").trim()
      const running = isToday && runningSessions !== null && Boolean(convId && runningSessions?.[convId]?.running === true)
      return {
        key: r.key,
        repo: r.repo,
        number: r.number,
        title: r.title,
        url: taskUrl(r),
        state,
        branch: r.branch,
        worktree: r.worktree,
        attempts: r.attempts,
        note: r.note,
        agent: r.agent || "",
        running,
        updatedAt,
        updatedAtClock: clockOf(updatedAt),
        firstSeenClock: clockOf(r.first_seen_at),
      }
    }).sort((a, b) =>
      taskStateRank(a.state) - taskStateRank(b.state) ||
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) ||
      b.number - a.number ||
      a.key.localeCompare(b.key)
    )

    const prs = prRows.map((r) => {
      const past = pastOf(r)
      const state = past ? past.state : r.state
      return {
        key: r.key,
        repo: r.repo,
        number: r.number,
        title: r.title,
        url: prUrl(r),
        author: r.author,
        skipped: r.skipped,
        state,
        notifiedTo: r.notified_to,
        notifiedAt: r.notified_at,
        notifiedAtClock: clockOf(r.notified_at),
        seenAt: r.first_seen_at,
        seenAtClock: clockOf(r.first_seen_at),
        pending: state === "pending",
      }
    })

    // 累计口径也要按那天算：回看时只算「到那天为止已经出现过的」。
    const totalTasks = isToday ? Number(this.q.countTasks.get().c) : taskKeys.size
    const totalPrs = isToday ? Number(this.q.countPrs.get().c) : prKeys.size
    const totalPolls = Number(this.q.countPolls.get().c)
    const prCfg = cfg?.prWatch || {}

    return {
      generatedAt: now.toISOString(),
      generatedAtClock: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      today,
      day: target,
      isToday,
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
        working: runningSessions === null ? tasks.filter((t) => t.state === "working").length : tasks.filter((t) => t.running).length,
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
