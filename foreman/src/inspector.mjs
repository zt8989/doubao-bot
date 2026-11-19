// 检查智能体：Foreman 只负责定时投递与投递失败后的会话轮换，接单、续跑、重派和本地完成均由智能体决策。
import { Book } from "./book.mjs"
import { builtinPrompt } from "./builtin-prompts.mjs"
import { cleanableIssues } from "./sessionflow.mjs"

const ACTIVE_STATES = new Set(["planned", "handed", "working", "pr-open", "needs-human", "blocked", "failed", "escalated"])

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-")
}

function issueLine(key, rec, running) {
  const worker = String(rec?.agentConvId ?? rec?.agent ?? "") || "未派"
  const live = worker !== "未派" && running?.[worker] ? `，执行会话${running[worker].running ? "运行中" : "未运行"}` : ""
  const failure = String(rec?.lastFailure ?? "").trim()
  const prs = Array.isArray(rec?.prs) && rec.prs.length
    ? `，PR=${rec.prs.map((p) => `${p.repo}#${p.pr}`).join("、")}`
    : rec?.pr ? `，PR=${rec.pr}` : ""
  return `- ${key}｜本地状态=${rec?.state ?? "未知"}｜编排=${rec?.orchestrator || "无"}｜执行=${worker}${live}${prs}${failure ? `｜最近失败=${failure}` : ""}`
}

export async function inspectionSnapshot(ctx) {
  const book = new Book(ctx.cfg.stateFile)
  let running = null
  if (typeof ctx.dws?.runningMap === "function") {
    try { running = await ctx.dws.runningMap() } catch { running = null }
  }
  const active = Object.entries(book.issues ?? {})
    .filter(([, rec]) => ACTIVE_STATES.has(String(rec?.state ?? "")))
    .sort(([a], [b]) => a.localeCompare(b))
  const issues = active.slice(0, 60).map(([key, rec]) => issueLine(key, rec, running))
  const maxRunning = Number(ctx.cfg.pickup?.maxRunning ?? 2)
  const remaining = Math.max(0, maxRunning - active.length)
  const cleanup = cleanableIssues(book)
  return [
    "每轮先执行 `foreman tasks --json`；只对 state=done/cleaned 的残留任务执行 `foreman clean --all`，及时清理已合并、已关闭工单的工作区与会话。working/pr-open 等非终态不得清理。",
    `已收口待清理快照：${cleanup.length ? cleanup.join("、") : "空。"}`,
    `在飞容量：${active.length}/${maxRunning}；还可新接：${remaining}。这是全部未收口工单的合计上限，不是本轮新增额度。`,
    "dry-run 只用于确认候选优先级，不得采用它的空余槽位；达到上限时禁止 run/pickup/hand/orch start/dispatch 接新单。handed 也占槽，每次接单后重新计算。",
    issues.length ? "未收口工单快照：" : "未收口工单快照：空。",
    ...issues,
  ].join("\n")
}

async function deliver(ctx, rec, text, { now, action, reason = "" }) {
  const { cfg, dws } = ctx
  const book = new Book(cfg.stateFile)
  let convId = rec?.convId ?? ""
  let name = rec?.name ?? ""
  if (action === "created") {
    name = `foreman-检查-${stamp(now)}`
    const projectDir = String(cfg.inspector?.projectDir ?? cfg.deliver?.projectDir ?? "").trim()
    const first = [
      builtinPrompt("inspector"),
      projectDir ? `监控项目目录：${projectDir}` : "",
      rec?.convId ? `上一条检查会话 ${rec.convId} 已连续 24 小时未成功接收巡检；你接替它，不假定旧会话仍可用。` : "",
      "这是首次巡检，请按上面的职责开始检查。",
      text,
    ].filter(Boolean).join("\n\n")
    const opened = await dws.openNew({ name, prompt: first, noWait: true })
    convId = String(opened?.convId ?? "").trim()
    if (!convId) throw new Error("新建检查会话成功返回但没有 convId")
  } else {
    // 排到当前轮次之后，避免 steer 插入造成同一轮重复飞行检查。
    await dws.queue(convId, text)
  }

  const at = now.toISOString()
  const previous = book.data.inspector ?? {}
  const history = action === "created" && previous.convId
    ? [...(previous.history ?? []), { convId: previous.convId, name: previous.name ?? "", lastSentAt: previous.lastSentAt ?? "" }].slice(-20)
    : previous.history ?? []
  book.data.inspector = {
    ...previous,
    convId,
    name,
    createdAt: action === "created" ? at : previous.createdAt ?? at,
    lastAttemptAt: at,
    lastSentAt: at,
    failingSince: "",
    sendCount: Number(previous.sendCount ?? 0) + 1,
    error: "",
    history,
  }
  book.record(name, {
    convId,
    kind: "inspector",
    role: "inspector",
    notify: false,
    createdAt: action === "created" ? at : previous.createdAt ?? at,
    lastInspectionAt: at,
  })
  book.save()
  return { ok: true, action, ...(reason ? { reason } : {}), convId, name, sentAt: at }
}

export async function inspectorOnce(ctx, { now = new Date(), force = false, notice = "", notices = null, scheduled = null } = {}) {
  const runtime = ctx.state?.inspector ?? (ctx.state ? (ctx.state.inspector = {}) : {})
  if (runtime.running) return { ok: true, skipped: "busy" }
  runtime.running = true
  const book = new Book(ctx.cfg.stateFile)
  const rec = book.data.inspector ?? {}
  try {
    if (ctx.cfg.inspector?.enabled === false && !force) return { ok: true, skipped: "disabled" }
    if (typeof ctx.dws?.openNew !== "function" || typeof ctx.dws?.queue !== "function") {
      throw new Error("dws 缺少 openNew/queue，无法投递检查智能体")
    }
    const staleMs = Number(ctx.cfg.inspector?.recreateAfterHours ?? 24) * 3600000
    const lastSent = Date.parse(rec.lastSentAt ?? "")
    const failingSince = Date.parse(rec.failingSince ?? "")
    const createdAt = Date.parse(rec.createdAt ?? "")
    const idleSince = Number.isFinite(lastSent) ? lastSent : Number.isFinite(failingSince) ? failingSince : createdAt
    const stale = Boolean(rec.convId) && Number.isFinite(idleSince) && now.getTime() - idleSince >= staleMs
    const action = !rec.convId || stale ? "created" : "queued"
    const noticeList = notices === null
      ? [String(notice ?? "").trim()].filter(Boolean)
      : notices.map((item) => String(item ?? "").trim()).filter(Boolean)
    const includeScheduled = scheduled === null ? noticeList.length === 0 : scheduled === true
    const sections = []
    if (includeScheduled) {
      sections.push([
        "【Foreman · 检查智能体 · 10分钟巡检】",
        "请检查任务是否正常运行；先按 tasks 核对全部在飞工单总数，达到上限时禁止接新，只有仍有容量才按优先级接单。状态处理由你决策，不要机械重派。",
        await inspectionSnapshot(ctx),
      ].join("\n\n"))
    }
    sections.push(...noticeList)
    const text = sections.join("\n\n")
    const out = await deliver(ctx, rec, text, { now, action, reason: stale ? "stale-24h" : "" })
    runtime.lastAt = out.sentAt
    runtime.count = Number(runtime.count ?? 0) + 1
    runtime.lastResult = out
    ctx.log?.(`检查智能体：${action === "created" ? "新建" : "复用"}会话 ${out.convId}，巡检投递成功`)
    return out
  } catch (e) {
    const at = now.toISOString()
    const failed = new Book(ctx.cfg.stateFile)
    const previous = failed.data.inspector ?? rec
    failed.data.inspector = {
      ...previous,
      lastAttemptAt: at,
      failingSince: previous.failingSince || at,
      error: e.message,
    }
    failed.save()
    const out = { ok: false, error: e.message, convId: rec.convId ?? "", lastSentAt: rec.lastSentAt ?? "" }
    runtime.lastResult = out
    ctx.log?.(`检查智能体巡检投递失败：${e.message}`)
    return out
  } finally {
    runtime.running = false
  }
}
