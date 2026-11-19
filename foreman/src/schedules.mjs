// 定时任务开关：prWatch.enabled / mail.enabled / router.enabled / workHours.offUntil
// 页面上一键启停，写回 config.json 并立刻重排服务里的定时器（不用重启）。
import fs from "node:fs"
import { inWorkHours } from "./util.mjs"
import { validateCron } from "./cron.mjs"
import { normalizeScriptExecutor, scriptExecutor } from "./executors.mjs"

const pad = (n) => String(n).padStart(2, "0")

export const SCHEDULE_IDS = ["prWatch", "mail", "router", "dreaming", "workHours"]

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
  const section = cfg?.[id] ?? (id === "router" ? cfg?.inspector : id === "dreaming" ? cfg?.memory?.dreaming : null) ?? {}
  if (String(section.cron ?? "").trim()) return String(section.cron).trim()
  if (id === "dreaming") return "0 3 * * *"
  const seconds = Number(
    section.intervalSeconds ??
      (id === "pickup" ? 1800 : id === "router" ? 600 : id === "mail" ? cfg?.mail?.pollSeconds ?? 300 : 300)
  )
  const minutes = Math.max(1, Math.round(seconds / 60))
  return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`
}

export function listSchedules(cfg, state = {}) {
  const w = cfg?.workHours ?? {}
  const offUntil = String(w.offUntil ?? "")
  const paused = offUntil ? new Date(offUntil).getTime() > Date.now() : false
  const prw = cfg?.prWatch ?? {}
  const r = cfg?.router ?? cfg?.inspector ?? {}
  return [
    {
      id: "prWatch",
      label: "他人 PR 扫描",
      enabled: prw.enabled === true,
      cron: cronOf(cfg, "prWatch"),
      executor: "script",
      script: scriptExecutor(cfg, "prWatch"),
      nextAt: state.pr?.nextAt || "",
      intervalSeconds: Number(prw.intervalSeconds ?? 300),
      detail: "脚本扫描 open PR；候选与通知异常写入 Inbox，普通扫描完成回执跳过",
      lastAt: state.pr?.lastPollAt || "",
      count: Number(state.pr?.pollCount ?? 0),
      lastResult: Number(state.pr?.notifiedCount ?? 0) ? `累计通知 ${Number(state.pr.notifiedCount)} 次` : "",
      runnable: true,
      runLabel: "立即扫描",
      running: state.pr?.polling === true,
    },
    {
      id: "mail",
      label: "邮件轮询",
      enabled: cfg?.mail?.enabled === true,
      cron: cronOf(cfg, "mail"),
      executor: "script",
      script: scriptExecutor(cfg, "mail"),
      nextAt: state.mail?.nextAt || "",
      intervalSeconds: Number(cfg?.mail?.pollSeconds ?? 300),
      detail: `UI 验收回复按 [FM-…] 判定，普通回复按 [FM-SID:…] 路由；验收人 ${(cfg?.mail?.testers ?? []).length} 个${
        (cfg?.mail?.testers ?? []).some((e) => /^</.test(String(e))) ? "（含占位符，未生效）" : ""
      } · 不受工作时间窗限制`,
      lastAt: state.mail?.lastPollAt || "",
      count: Number(state.mail?.pollCount ?? 0),
      lastResult: state.mail?.lastResult || "",
      runnable: true,
      runLabel: "立即收信",
      running: state.mail?.polling === true,
    },
    {
      id: "router",
      label: "执行会话轮询",
      enabled: r.enabled !== false,
      cron: cronOf(cfg, "router"),
      executor: "script",
      script: scriptExecutor(cfg, "router"),
      nextAt: state.router?.nextAt || "",
      intervalSeconds: Number(r.intervalSeconds ?? 600),
      detail: `每 ${Math.round(Number(r.intervalSeconds ?? 600) / 60)} 分钟由代码轮询已登记执行会话；状态变化写 task.update，普通检查完成不写 Inbox · 不定时调用 Agent，不自动接单 · 不受工作时间窗限制`,
      lastAt: state.lastPollAt || "",
      count: Number(state.pollCount ?? 0),
      lastResult: state.lastPollResult ?? null,
      runnable: true,
      runLabel: "立即轮询",
      running: state.polling === true,
    },
    {
      id: "dreaming",
      label: "每日记忆 dreaming",
      enabled: cfg?.memory?.dreaming?.enabled !== false,
      cron: cronOf(cfg, "dreaming"),
      executor: "agent",
      nextAt: state.dreaming?.nextAt || "",
      intervalSeconds: 0,
      detail: "每天整理前一日日记：Light 去重、REM 反思、Deep 受控提升；独立 Agent 只能通过 memory 命令写核心记忆，DREAMS.md 供审阅",
      lastAt: state.dreaming?.lastAt || "",
      count: Number(state.dreaming?.count ?? 0),
      lastResult: state.dreaming?.lastResult ?? null,
      runnable: true,
      runLabel: "立即整理",
      running: state.dreaming?.running === true,
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
      // 工作时间窗是个判断条件，没有可执行的轮次，所以不给「立即执行」。
      runnable: false,
      runLabel: "",
      running: false,
    },
  ]
}

function clockMinutes(value, label) {
  const text = String(value ?? "").trim()
  const m = /^(\d{2}):(\d{2})$/.exec(text)
  const hours = Number(m?.[1])
  const minutes = Number(m?.[2])
  if (!m || hours > 23 || minutes > 59) throw new Error(`${label}必须是有效的 HH:mm 时间`)
  return hours * 60 + minutes
}

function normalizeWorkHours(value, cfg) {
  const start = String(value.start ?? cfg.workHours?.start ?? "08:30").trim()
  const end = String(value.end ?? cfg.workHours?.end ?? "18:30").trim()
  const startAt = clockMinutes(start, "开始时间")
  const endAt = clockMinutes(end, "结束时间")
  if (startAt >= endAt) throw new Error("开始时间必须早于结束时间")
  const inputDays = value.days ?? cfg.workHours?.days ?? [1, 2, 3, 4, 5]
  if (!Array.isArray(inputDays) || inputDays.length === 0) throw new Error("工作日至少选择一天")
  const days = [...new Set(inputDays.map(Number))].sort((a, b) => a - b)
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error("星期必须是 1（周一）到 7（周日）")
  return { days, start, end }
}

/**
 * 改开关与 cron：只动内存里的 cfg，返回新状态。
 * patch 每项可以是布尔（纯开关），也可以是对象：
 *   { router: { enabled: true, cron: "*\/10 * * * *" } }
 * enabled 省略表示只改 cron；cron 非法直接抛错，不落盘、不重排。
 * workHours 的开关语义是「临时闭嘴 / 恢复」，不是改工作时段本身。
 */
export function applySchedules(cfg, patch = {}, at = new Date()) {
  if (patch.inspector && !patch.router) patch = { ...patch, router: patch.inspector }
  for (const id of SCHEDULE_IDS) {
    if (!(id in patch)) continue
    const raw = patch[id]
    const obj = raw && typeof raw === "object" ? raw : { enabled: raw === true || raw === "true" }
    if ("cron" in obj && !["prWatch", "mail", "router", "dreaming"].includes(id)) throw new Error(`${id} 不是独立定时任务，没有 cron 可改`)
    const next = {}
    if ("enabled" in obj) next.enabled = obj.enabled === true || obj.enabled === "true"
    if ("cron" in obj) {
      const v = validateCron(obj.cron)
      if (!v.ok) throw new Error(`${id} 的 cron 不合法：${v.error}`)
      next.cron = v.expression
    }
    if ("script" in obj && !["prWatch", "mail", "router"].includes(id)) throw new Error(`${id} 不是脚本执行器`)
    if ("agent" in obj) throw new Error(`${id} 不是 Agent 执行器`)
    if ("script" in obj) next.script = normalizeScriptExecutor(obj.script, cfg, id)
    if (id === "prWatch") {
      cfg.prWatch = { ...(cfg.prWatch ?? {}) }
      if ("enabled" in next) cfg.prWatch.enabled = next.enabled
      if ("cron" in next) cfg.prWatch.cron = next.cron
      if ("script" in next) cfg.prWatch.script = next.script
    } else if (id === "mail") {
      cfg.mail = { ...(cfg.mail ?? {}) }
      if ("enabled" in next) cfg.mail.enabled = next.enabled
      if ("cron" in next) cfg.mail.cron = next.cron
      if ("script" in next) cfg.mail.script = next.script
    } else if (id === "router") {
      cfg.router = { ...(cfg.router ?? {}) }
      if ("enabled" in next) cfg.router.enabled = next.enabled
      if ("cron" in next) cfg.router.cron = next.cron
      if ("script" in next) cfg.router.script = next.script
    } else if (id === "dreaming") {
      const dreaming = { ...(cfg.memory?.dreaming ?? {}) }
      if ("enabled" in next) dreaming.enabled = next.enabled
      if ("cron" in next) dreaming.cron = next.cron
      cfg.memory = { ...(cfg.memory ?? {}), dreaming }
    } else if (id === "workHours") {
      if ("days" in obj || "start" in obj || "end" in obj) cfg.workHours = { ...(cfg.workHours ?? {}), ...normalizeWorkHours(obj, cfg) }
      if ("enabled" in next) cfg.workHours = { ...(cfg.workHours ?? {}), offUntil: next.enabled ? "" : localIso(nextWorkdayStart(cfg, at)) }
    }
  }
  if (cfg.inspector && cfg.router) cfg.inspector = cfg.router
  return listSchedules(cfg)
}

/** 开关对应的配置键名（这几个节点都是 enabled）。 */
const FLAG_KEY = { prWatch: "enabled", mail: "enabled", router: "enabled", dreaming: "enabled" }

/**
 * 写回配置文件：只改上面这四个开关，其余字段（含用户手写的格式/注释式排版）原样保留。
 * 文件不存在就跳过——纯 CLI 跑的时候没有配置文件，开关只活在内存里。
 */
export function persistSchedules(file, patch = {}, cfg = {}) {
  if (patch.inspector && !patch.router) patch = { ...patch, router: patch.inspector }
  if (!file || !fs.existsSync(file)) return false
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  for (const id of SCHEDULE_IDS) {
    if (!(id in patch)) continue
    const value = patch[id]
    const obj = value && typeof value === "object" ? value : { enabled: value === true || value === "true" }
    if (id === "dreaming") {
      const section = { ...(raw.memory?.dreaming ?? {}) }
      if ("enabled" in obj) section.enabled = obj.enabled === true || obj.enabled === "true"
      if ("cron" in obj) section.cron = String(cfg?.memory?.dreaming?.cron ?? obj.cron)
      raw.memory = { ...(raw.memory ?? {}), dreaming: section }
      continue
    }
    const section = { ...(raw[id] ?? {}) }
    if (id === "workHours") {
      if ("days" in obj || "start" in obj || "end" in obj) Object.assign(section, normalizeWorkHours(obj, cfg))
      if ("enabled" in obj) section.offUntil = String(cfg?.workHours?.offUntil ?? "")
    } else {
      if ("enabled" in obj) section[FLAG_KEY[id]] = obj.enabled === true || obj.enabled === "true"
      if ("cron" in obj) section.cron = String(cfg?.[id]?.cron ?? obj.cron)
      if ("script" in obj) section.script = { ...cfg[id].script, args: { ...cfg[id].script.args } }
    }
    raw[id] = section
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n")
  return true
}
