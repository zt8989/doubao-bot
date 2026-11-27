// 定时任务只以 SQLite 为准；config.json 仅在首次初始化时提供旧配置迁移值。
// 页面上一键启停，写入 agent_schedules / agent_schedule_settings 并立刻重排定时器。
import { inWorkHours } from "../util.mjs"
import { validateCron, nextCronTime } from "./cron.mjs"
import { normalizeScriptExecutor, scriptExecutor } from "./executors.mjs"
import { agentScheduleCwd } from "../config.mjs"

const pad = (n) => String(n).padStart(2, "0")

export const SCHEDULE_IDS = ["pickup", "prWatch", "mail", "router", "workHours", "apiWatch"]

/** 配置里登记的自定义 Agent 定时任务（每条到点新开一条豆包会话）。 */
export function customAgentSchedules(cfg) {
  return Array.isArray(cfg?.agentSchedules) ? cfg.agentSchedules : []
}

const BUILTIN_SCHEDULE_IDS = ["pickup", "prWatch", "mail", "router", "apiWatch"]

/** 创建自定义 Agent 任务时占用的保留 id：内置任务 + 没有独立 cron 的两项。 */
const RESERVED_SCHEDULE_IDS = [...BUILTIN_SCHEDULE_IDS, "inspector", "workHours"]

/**
 * 新建或按 id 覆盖一条自定义 Agent 定时任务（HTTP 创建入口用，不必改配置文件、不必重启）。
 * 只校验并把定义写回 cfg；落 SQLite 与重排定时器仍由 service 的 armSchedules 完成。
 */
export function createAgentSchedule(cfg, input = {}) {
  const raw = input && typeof input === "object" ? input : {}
  const id = String(raw.id ?? "").trim()
  if (!id) throw new Error("定时任务缺少 id")
  cfg.agentSchedules = [...customAgentSchedules(cfg)]
  const existing = cfg.agentSchedules.find((item) => item.id === id)
  // 新建才校验命名与保留字；覆盖已有任务按原 id 走，避免历史 id 被卡住。
  if (!existing && !/^[a-z][a-z0-9_-]{1,31}$/.test(id)) throw new Error(`定时任务 id 只能用小写字母、数字、_ 或 -：${id}`)
  if (!existing && RESERVED_SCHEDULE_IDS.includes(id)) throw new Error(`${id} 与内置定时任务重名`)
  const cron = validateCron(raw.cron)
  if (!cron.ok) throw new Error(`cron 不合法：${cron.error}`)
  const prompt = String(raw.prompt ?? "")
  if (!prompt.trim()) throw new Error("Agent 定时任务必须提供提示词 prompt")
  if (!existing && cfg.agentSchedules.length >= 10) throw new Error("Agent 定时任务最多 10 条")

  const item = {
    id,
    label: String(raw.label ?? "").trim() || existing?.label || id,
    cron: cron.expression,
    enabled: raw.enabled !== false,
    prompt,
    cwd: agentScheduleCwd(raw.cwd ?? existing?.cwd),
    detail: String(raw.detail ?? "").trim() || existing?.detail || "",
  }
  if (existing) Object.assign(existing, item)
  else cfg.agentSchedules.push(item)
  return { item, created: !existing }
}

/**
 * 新建任务的首次触发时间：排到下一个 cron 点，不在创建当场立刻跑。
 * 想马上跑用 /api/schedules/run（或控制台「立即执行」）。
 */
export function firstRunAt(cron, at = new Date()) {
  return nextCronTime(cron, at)
}


/**
 * 启动时把 SQLite 中的任务定义灌回运行时配置。
 * 首次升级时，缺失的字段仍可取旧 config.json；initialized 写入后，文件里的调度字段不再生效。
 */
export function hydrateSchedules(cfg, store) {
  const rows = store.schedules()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const initialized = store.scheduleSetting("initialized")?.value === true

  for (const id of BUILTIN_SCHEDULE_IDS) {
    const row = byId.get(id)
    if (!row) continue
    cfg[id] = {
      ...(cfg[id] ?? {}),
      [id === "pickup" ? "auto" : "enabled"]: row.enabled,
      cron: row.cron,
      ...(row.payload?.script ? { script: row.payload.script } : {}),
    }
  }

  const customRows = rows.filter((row) => row.kind === "agent" && row.id !== "inspector")
  if (initialized || customRows.length) {
    const legacy = customAgentSchedules(cfg)
    cfg.agentSchedules = customRows.map((row) => {
      const old = legacy.find((item) => item.id === row.id) ?? {}
      return {
        id: row.id,
        label: String(row.payload?.label ?? old.label ?? row.id),
        cron: row.cron,
        enabled: row.enabled,
        prompt: String(row.payload?.prompt ?? old.prompt ?? ""),
        cwd: agentScheduleCwd(row.payload?.cwd ?? old.cwd),
        detail: String(row.payload?.detail ?? old.detail ?? ""),
      }
    })
  }

  const workHours = store.scheduleSetting("workHours")
  if (workHours && typeof workHours === "object") cfg.workHours = { ...(cfg.workHours ?? {}), ...workHours }
  if (cfg.inspector && cfg.router) cfg.inspector = cfg.router
  return cfg
}

/** 运行时配置序列化成 SQLite 任务定义；脚本与 Agent 提示词也放在同一行 payload。 */
export function scheduleDefinitions(cfg) {
  const script = (id, enabled) => ({
    id,
    kind: id,
    executor: "script",
    cron: cronOf(cfg, id),
    enabled,
    payload: { script: scriptExecutor(cfg, id) },
  })
  return [
    script("pickup", cfg.pickup?.auto === true),
    script("prWatch", cfg.prWatch?.enabled === true),
    script("mail", cfg.mail?.enabled === true),
    script("router", (cfg.router ?? cfg.inspector)?.enabled === true),
    script("apiWatch", cfg.apiWatch?.enabled === true),
    ...customAgentSchedules(cfg).map((item) => ({
      id: item.id,
      kind: "agent",
      executor: "agent",
      cron: item.cron,
      enabled: item.enabled !== false,
      payload: { custom: true, label: item.label || item.id, prompt: String(item.prompt ?? ""), cwd: agentScheduleCwd(item.cwd), detail: String(item.detail ?? "") },
    })),
    // 停用旧持久 Schedule；旧 Inbox 事件仍由 router handler 兼容消费。
    { id: "inspector", kind: "inspector", executor: "agent", cron: cronOf(cfg, "router"), enabled: false },
  ]
}

/** 工作时间与迁移标记也落 SQLite，和任务定义在同一数据库完成初始化。 */
export function saveScheduleSettings(store, cfg) {
  store.tx(() => {
    store.saveScheduleSetting("workHours", {
      enabled: cfg.workHours?.enabled === true,
      days: [...(cfg.workHours?.days ?? [1, 2, 3, 4, 5])],
      start: String(cfg.workHours?.start ?? "08:30"),
      end: String(cfg.workHours?.end ?? "18:30"),
      offUntil: String(cfg.workHours?.offUntil ?? ""),
    })
    store.saveScheduleSetting("initialized", { value: true })
  })
}

function customScheduleRows(cfg, state = {}) {
  const runtimeOf = (id) => (state.agentSchedules ?? {})[id] ?? {}
  return customAgentSchedules(cfg).map((item) => {
    const runtime = runtimeOf(item.id)
    return {
      id: item.id,
      label: item.label || item.id,
      enabled: item.enabled !== false,
      cron: item.cron,
      executor: "agent",
      cwd: agentScheduleCwd(item.cwd),
      agent: { prompt: String(item.prompt ?? ""), cwd: agentScheduleCwd(item.cwd), custom: true },
      nextAt: runtime.nextAt || "",
      intervalSeconds: 0,
      detail: String(item.detail ?? "").trim() || "到点新开一条豆包会话，把提示词作为首句投递；跑完在本会话直接给最终回复",
      lastAt: runtime.lastAt || "",
      count: Number(runtime.count ?? 0),
      lastResult: runtime.lastResult ?? null,
      runnable: true,
      runLabel: "立即执行",
      running: runtime.running === true,
    }
  })
}

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
  const section = cfg?.[id] ?? (id === "router" ? cfg?.inspector : null) ?? {}
  if (String(section.cron ?? "").trim()) return String(section.cron).trim()
  if (id === "apiWatch") return "0 9-18/2 * * 1-5"
  const seconds = Number(
    section.intervalSeconds ??
      (id === "pickup" ? 1800 : id === "router" ? 60 : id === "mail" ? cfg?.mail?.pollSeconds ?? 300 : 300)
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
      id: "pickup",
      label: "我的工单自动接单",
      enabled: cfg?.pickup?.auto === true,
      cron: cronOf(cfg, "pickup"),
      executor: "script",
      script: scriptExecutor(cfg, "pickup"),
      nextAt: state.pickup?.nextAt || "",
      intervalSeconds: Number(cfg?.pickup?.intervalSeconds ?? 1800),
      detail: `筛选 open、指派给 ${cfg?.pickup?.me ?? "pickup.me"} 且带 ready-for-agent 的工单；候选写 Inbox，由 router agent 分配编码智能体`,
      lastAt: state.pickup?.lastPollAt || "",
      count: Number(state.pickup?.pollCount ?? 0),
      lastResult: state.pickup?.lastScanResult
        ?? (Number(state.pickup?.notifiedCount ?? 0) ? `累计入箱 ${Number(state.pickup.notifiedCount)} 条候选` : ""),
      runnable: true,
      runLabel: "立即扫描",
      running: state.pickup?.polling === true,
    },
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
      intervalSeconds: Number(r.intervalSeconds ?? 60),
      detail: `每 ${Math.round(Number(r.intervalSeconds ?? 60) / 60)} 分钟由代码轮询已登记执行会话；状态变化写 task.update，普通检查完成不写 Inbox · 不定时调用 Agent，不自动接单 · 不受工作时间窗限制`,
      lastAt: state.lastPollAt || "",
      count: Number(state.pollCount ?? 0),
      lastResult: state.lastPollResult ?? null,
      runnable: true,
      runLabel: "立即轮询",
      running: state.polling === true,
    },
    {
      id: "apiWatch",
      label: "存量接口变更巡检",
      enabled: cfg?.apiWatch?.enabled === true,
      cron: cronOf(cfg, "apiWatch"),
      executor: "script",
      script: scriptExecutor(cfg, "apiWatch"),
      nextAt: state.apiWatch?.nextAt || "",
      intervalSeconds: 0,
      detail: `定时扫各仓已合并 PR，diff 触及接口定义文件的候选交独立判官会话精判；确认改了存量接口出入参的发飞书群（${(cfg?.apiWatch?.chatIds ?? []).length} 个）· chatIds 在 config.json apiWatch 段配置`,
      lastAt: state.apiWatch?.lastPollAt || "",
      count: Number(state.apiWatch?.pollCount ?? 0),
      lastResult: state.apiWatch?.lastResult || "",
      runnable: true,
      runLabel: "立即检查",
      running: state.apiWatch?.polling === true,
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
    ...customScheduleRows(cfg, state),
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
  const customIds = customAgentSchedules(cfg).map((item) => item.id)
  for (const id of [...SCHEDULE_IDS, ...customIds]) {
    if (!(id in patch)) continue
    const raw = patch[id]
    const obj = raw && typeof raw === "object" ? raw : { enabled: raw === true || raw === "true" }
    const custom = customAgentSchedules(cfg).find((item) => item.id === id)
    if ("cron" in obj && !["pickup", "prWatch", "mail", "router", "apiWatch"].includes(id) && !custom) throw new Error(`${id} 不是独立定时任务，没有 cron 可改`)
    const next = {}
    if ("enabled" in obj) next.enabled = obj.enabled === true || obj.enabled === "true"
    if ("cron" in obj) {
      const v = validateCron(obj.cron)
      if (!v.ok) throw new Error(`${id} 的 cron 不合法：${v.error}`)
      next.cron = v.expression
    }
    if ("script" in obj && !["pickup", "prWatch", "mail", "router"].includes(id)) throw new Error(`${id} 不是脚本执行器`)
    if ("agent" in obj && !custom) throw new Error(`${id} 不是 Agent 执行器`)
    if ("script" in obj) next.script = normalizeScriptExecutor(obj.script, cfg, id)
    if (custom) {
      // 自定义 Agent 任务只改开关、cron 与提示词；提示词不能改成空串。
      if ("enabled" in next) custom.enabled = next.enabled
      if ("cron" in next) custom.cron = next.cron
      if (obj.agent && "prompt" in obj.agent) {
        const prompt = typeof obj.agent.prompt === "string" ? obj.agent.prompt : null
        if (prompt === null || !prompt.trim()) throw new Error(`${id} 的 Agent 提示词不能为空`)
        custom.prompt = prompt
      }
      // cwd 可写在 agent.cwd 或顶层 cwd；空串 = 回到默认（脚本所在位置）。
      if (obj.agent && "cwd" in obj.agent) custom.cwd = agentScheduleCwd(obj.agent.cwd)
      else if ("cwd" in obj) custom.cwd = agentScheduleCwd(obj.cwd)
      continue
    }
    if (id === "pickup") {
      cfg.pickup = { ...(cfg.pickup ?? {}) }
      if ("enabled" in next) cfg.pickup.auto = next.enabled
      if ("cron" in next) cfg.pickup.cron = next.cron
      if ("script" in next) cfg.pickup.script = next.script
    } else if (id === "prWatch") {
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
    } else if (id === "apiWatch") {
      cfg.apiWatch = { ...(cfg.apiWatch ?? {}) }
      if ("enabled" in next) cfg.apiWatch.enabled = next.enabled
      if ("cron" in next) cfg.apiWatch.cron = next.cron
      if ("script" in next) cfg.apiWatch.script = next.script
    } else if (id === "workHours") {
      if ("days" in obj || "start" in obj || "end" in obj) cfg.workHours = { ...(cfg.workHours ?? {}), ...normalizeWorkHours(obj, cfg) }
      if ("enabled" in next) cfg.workHours = { ...(cfg.workHours ?? {}), offUntil: next.enabled ? "" : localIso(nextWorkdayStart(cfg, at)) }
    }
  }
  if (cfg.inspector && cfg.router) cfg.inspector = cfg.router
  return listSchedules(cfg)
}
