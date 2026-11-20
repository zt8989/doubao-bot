// router agent：接收未定向消息、巡检、接单与异常分派；Foreman 只负责持久投递和会话轮换。
import { Book } from "../book.mjs"
import { agentExecutor } from "./executors.mjs"
import { memoryBootstrap } from "./memory.mjs"

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-")
}

// 保留旧导出名作内部兼容；周期消息只含巡检指令，不再读取账本或注入历史清单。
export async function inspectionSnapshot() {
  return [
    "本轮先执行 `foreman tasks --json`，只使用这次 sessions 树与 summary 的实时结果，不沿用此前轮次的数据或清单。节点 state 是会话 running/idle/gone/unknown，issueState 仅作归属、容量和清理元数据。状态处理由你决策，不机械重派。",
    "分别统计：未收口 X=summary.unresolvedIssues（合计上限 2，handed 占槽）；真实运行 N=编码节点 state=running，工单号取节点 issueKey，编排/router 不算编码执行；PR 待验收/合并 P=summary.prOpenIssues。8/2 不是 8 个正在运行，unknown 不得猜测。满额禁止 run/pickup/hand/orch start/dispatch；dry-run 仅看候选优先级。",
    "已收口仅指 issueState=done/cleaned，不代表工作区或会话已清理。clean --all 只对终态做幂等检查，working/pr-open/failed 等非终态不得清理；cleaned/keys 是候选数，不是实际清理数。无 notes 删除或归档证据时只报“终态清理检查完成，未误清理非终态任务”。",
    "汇报仅写：在飞 X/2（其中 PR 待验收/合并 P 个）、真实运行 N 个及工单号、本轮状态变化/实际动作、异常；无变化用一句话，不复述历史清单和规则。",
  ].join("\n")
}

function routerConfig(cfg) {
  return cfg.router ?? cfg.inspector ?? {}
}

function routerRecord(book) {
  return book.data.router ?? book.data.inspector ?? {}
}

function saveRouterRecord(book, value) {
  // inspector 仅作旧账本兼容；新读取一律优先 router。
  book.data.router = value
  book.data.inspector = value
}

async function deliver(ctx, rec, text, { now, action, reason = "", scheduled = false }) {
  const { cfg, dws } = ctx
  const book = new Book(cfg.stateFile)
  let convId = rec?.convId ?? ""
  let name = rec?.name ?? ""
  if (action === "created") {
    name = `foreman-router-${stamp(now)}`
    const projectDir = String(routerConfig(cfg).projectDir ?? cfg.deliver?.projectDir ?? "").trim()
    const first = [
      agentExecutor(cfg).prompt,
      memoryBootstrap(cfg),
      projectDir ? `监控项目目录：${projectDir}` : "",
      rec?.convId ? `上一条 router agent 会话 ${rec.convId} 已连续 24 小时未成功接收消息；你接替它，不假定旧会话仍可用。` : "",
      scheduled
        ? "这是首次巡检，请按上面的职责开始检查。"
        : "这是 router agent 的首条事件，请按上面的职责处理。",
      text,
    ].filter(Boolean).join("\n\n")
    const opened = await dws.openNew({ name, prompt: first, noWait: true })
    convId = String(opened?.convId ?? "").trim()
    if (!convId) throw new Error("新建 router agent 会话成功返回但没有 convId")
  } else {
    await dws.queue(convId, text)
  }

  const at = now.toISOString()
  const previous = routerRecord(book)
  const history = action === "created" && previous.convId
    ? [...(previous.history ?? []), { convId: previous.convId, name: previous.name ?? "", lastSentAt: previous.lastSentAt ?? "" }].slice(-20)
    : previous.history ?? []
  saveRouterRecord(book, {
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
  })
  book.record(name, {
    convId,
    kind: "router",
    role: "router",
    notify: false,
    createdAt: action === "created" ? at : previous.createdAt ?? at,
    lastRouteAt: at,
  })
  book.save()
  return { ok: true, action, ...(reason ? { reason } : {}), convId, name, sentAt: at }
}

export async function routerOnce(ctx, { now = new Date(), force = false, notice = "", notices = null, scheduled = null } = {}) {
  const runtime = ctx.state?.router ?? ctx.state?.inspector ?? (ctx.state ? (ctx.state.router = {}) : {})
  if (runtime.running) return { ok: true, skipped: "busy" }
  runtime.running = true
  const book = new Book(ctx.cfg.stateFile)
  const rec = routerRecord(book)
  try {
    if (routerConfig(ctx.cfg).enabled === false && !force) return { ok: true, skipped: "disabled" }
    if (typeof ctx.dws?.openNew !== "function" || typeof ctx.dws?.queue !== "function") {
      throw new Error("dws 缺少 openNew/queue，无法投递 router agent")
    }
    const staleMs = Number(routerConfig(ctx.cfg).recreateAfterHours ?? 24) * 3600000
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
        "【Foreman · router agent · 按需巡检】",
        await inspectionSnapshot(ctx),
      ].join("\n\n"))
    }
    sections.push(...noticeList)
    const text = sections.join("\n\n")
    const out = await deliver(ctx, rec, text, { now, action, reason: stale ? "stale-24h" : "", scheduled: includeScheduled })
    runtime.lastAt = out.sentAt
    runtime.count = Number(runtime.count ?? 0) + 1
    runtime.lastResult = out
    ctx.log?.(`router agent：${action === "created" ? "新建" : "复用"}会话 ${out.convId}，消息投递成功`)
    return out
  } catch (e) {
    const at = now.toISOString()
    const failed = new Book(ctx.cfg.stateFile)
    const previous = routerRecord(failed)
    saveRouterRecord(failed, {
      ...previous,
      lastAttemptAt: at,
      failingSince: previous.failingSince || at,
      error: e.message,
    })
    failed.save()
    const out = { ok: false, error: e.message, convId: rec.convId ?? "", lastSentAt: rec.lastSentAt ?? "" }
    runtime.lastResult = out
    ctx.log?.(`router agent 消息投递失败：${e.message}`)
    return out
  } finally {
    runtime.running = false
  }
}
