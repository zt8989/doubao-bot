// 定时任务开关：pickup.auto / prWatch.enabled / planner.enabled / workHours.offUntil
// 页面上一键启停，写回 config.json 并立刻重排服务里的定时器（不用重启）。
import fs from "node:fs"
import { inWorkHours } from "./util.mjs"
import { validateCron } from "./cron.mjs"

const pad = (n) => String(n).padStart(2, "0")

export const SCHEDULE_IDS = ["pickup", "prWatch", "planner", "workHours"]

// 临时闭嘴恢复的时刻：今天还没到开始时间且今天是工作日就今天，否则下一个工作日。
export function nextWorkdayStart(cfg, at = new Date()) {
  const w = cfg?.workHours ?? {}
  const [h, m] = String(w.start ?? "08:30").split(":").map((x) => Number(x) || 0)
  const days = (w.days ?? [1, 2, 3, 4, 5]).map(Number)
  const onlyDays = w.enabled !== false
  for (let i = 0; i < 8; i++) {
    const probe = new Date(at.getFullYear(), at.getMonth(), at.getDate() + i, h, m, 0, 0)
    if (probe.getTime() <= at.getTime()) continue
    const day = probe.getDay() === 0 ? 7 : probe.getDay()
    if (!onlyDays || days.includes(day)) return probe
  }
  return new Date(at)
}

const localIso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`

/** 给页面看的开关状态。 */
/**
 * 某项任务的 cron 表达式：配了 cron 就用 cron，否则按老的 intervalSeconds 折成分钟级 cron。
 * 会话监听是 20 秒一轮，不在这里（cron 最小粒度是分钟）。
 */
export function cronOf(cfg, id) {
  const section = cfg?.[id] ?? {}
  if (String(section.cron ?? "").trim()) return String(section.cron).trim()
  const seconds = Number(section.intervalSeconds ?? (id === "pickup" ? 1800 : 300))
  const minutes = Math.max(1, Math.round(seconds / 60))
  return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`
}

export function listSchedules(cfg, state = {}) {
  const w = cfg?.workHours ?? {}
  const offUntil = String(w.offUntil ?? "")
  const paused = offUntil ? new Date(offUntil).getTime() > Date.now() : false
  const pickup = cfg?.pickup ?? {}
  const prw = cfg?.prWatch ?? {}
  const pl = cfg?.planner ?? {}
  return [
    {
      id: "pickup",
      label: "自动接单",
      enabled: pickup.auto === true,
      cron: cronOf(cfg, "pickup"),
      nextAt: state.pickup?.nextAt || "",
      intervalSeconds: Number(pickup.intervalSeconds ?? 1800),
      detail: `每轮最多 ${Number(pickup.maxPerRound ?? 1)} 条`,
      lastAt: state.pickup?.lastAt || "",
      count: Number(state.pickup?.count ?? 0),
      lastResult: state.pickup?.lastResult || "",
    },
    {
      id: "prWatch",
      label: "PR 扫描",
      enabled: prw.enabled === true,
      cron: cronOf(cfg, "prWatch"),
      nextAt: state.pr?.nextAt || "",
      intervalSeconds: Number(prw.intervalSeconds ?? 300),
      detail: "扫配置里各仓库的 open PR",
      lastAt: state.pr?.lastPollAt || "",
      count: Number(state.pr?.pollCount ?? 0),
      lastResult: Number(state.pr?.notifiedCount ?? 0) ? `累计通知 ${Number(state.pr.notifiedCount)} 次` : "",
    },
    {
      id: "planner",
      label: "续接调度",
      enabled: pl.enabled === true,
      intervalSeconds: 0,
      detail: `跟随监听轮询；在跑上限 ${Number(pl.maxRunning ?? 2)}`,
      lastAt: "",
      count: 0,
      lastResult: pl.enabled === true ? "" : "关闭后跑完不再催编排接单",
    },
    {
      id: "workHours",
      label: "工作时间窗",
      // 这里 enabled 表示「现在允许运行」：闭嘴期间就是 false。
      enabled: !paused,
      intervalSeconds: 0,
      detail: `周${(w.days ?? [1, 2, 3, 4, 5]).map((d) => "一二三四五六日"[Number(d) - 1]).join("/")} ${w.start ?? "08:30"}–${w.end ?? "17:30"}`,
      lastAt: "",
      count: 0,
      lastResult: paused ? `闭嘴到 ${offUntil}` : inWorkHours(cfg) ? "当前在窗口内" : "当前不在窗口内",
      offUntil: paused ? offUntil : "",
    },
  ]
}

/**
 * 改开关与 cron：只动内存里的 cfg，返回新状态。
 * patch 每项可以是布尔（纯开关），也可以是对象：
 *   { pickup: { enabled: true, cron: "*\/15 8-17 * * 1-5" } }
 * enabled 省略表示只改 cron；cron 非法直接抛错，不落盘、不重排。
 * workHours 的开关语义是「临时闭嘴 / 恢复」，不是改工作时段本身。
 */
export function applySchedules(cfg, patch = {}, at = new Date()) {
  for (const id of SCHEDULE_IDS) {
    if (!(id in patch)) continue
    const raw = patch[id]
    const obj = raw && typeof raw === "object" ? raw : { enabled: raw === true || raw === "true" }
    if ("cron" in obj && id !== "pickup" && id !== "prWatch") throw new Error(`${id} 不是独立定时任务，没有 cron 可改`)
    const next = {}
    if ("enabled" in obj) next.enabled = obj.enabled === true || obj.enabled === "true"
    if ("cron" in obj) {
      const v = validateCron(obj.cron)
      if (!v.ok) throw new Error(`${id} 的 cron 不合法：${v.error}`)
      next.cron = v.expression
    }
    if (id === "pickup") {
      cfg.pickup = { ...(cfg.pickup ?? {}) }
      if ("enabled" in next) cfg.pickup.auto = next.enabled
      if ("cron" in next) cfg.pickup.cron = next.cron
    } else if (id === "prWatch") {
      cfg.prWatch = { ...(cfg.prWatch ?? {}) }
      if ("enabled" in next) cfg.prWatch.enabled = next.enabled
      if ("cron" in next) cfg.prWatch.cron = next.cron
    } else if (id === "planner") {
      if ("enabled" in next) cfg.planner = { ...(cfg.planner ?? {}), enabled: next.enabled }
    } else if (id === "workHours" && "enabled" in next) {
      cfg.workHours = { ...(cfg.workHours ?? {}), offUntil: next.enabled ? "" : localIso(nextWorkdayStart(cfg, at)) }
    }
  }
  return listSchedules(cfg)
}

/** 开关对应的配置键名（pickup.auto，其余是 enabled）。 */
const FLAG_KEY = { pickup: "auto", prWatch: "enabled", planner: "enabled" }

/**
 * 写回配置文件：只改上面这四个开关，其余字段（含用户手写的格式/注释式排版）原样保留。
 * 文件不存在就跳过——纯 CLI 跑的时候没有配置文件，开关只活在内存里。
 */
export function persistSchedules(file, patch = {}, cfg = {}) {
  if (!file || !fs.existsSync(file)) return false
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  for (const id of SCHEDULE_IDS) {
    if (!(id in patch)) continue
    const value = patch[id]
    const obj = value && typeof value === "object" ? value : { enabled: value === true || value === "true" }
    const section = { ...(raw[id] ?? {}) }
    if (id === "workHours") {
      if ("enabled" in obj) section.offUntil = String(cfg?.workHours?.offUntil ?? "")
    } else {
      if ("enabled" in obj) section[FLAG_KEY[id]] = obj.enabled === true || obj.enabled === "true"
      if ("cron" in obj) section.cron = String(cfg?.[id]?.cron ?? obj.cron)
    }
    raw[id] = section
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n")
  return true
}
