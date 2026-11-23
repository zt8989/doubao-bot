// router agent：接收未定向消息、巡检、接单与异常分派；Foreman 只负责持久投递和会话轮换。
import { Book } from "../book.mjs"
import { agentExecutor } from "./executors.mjs"
import { builtinAgentPromptPath } from "../builtin-prompts.mjs"
import { memoryBootstrap } from "./memory.mjs"

// 子智能体分配协议：编码/审查不再由 router 亲自干或用无模板的内部 sub agent，
// 而是用 ZCode 自带 CreateSession 开独立根会话，各自读共享目录里自己的岗位提示词文件。
// 绝对路径在组装首句时现算（src/dist 各自成立）；delivered 会话无 --cwd，必须绝对路径。
// 实机探针（2026-11-23）：headless 下 CreateSession/SendToSession/WaitSessions/ReadSession 可用，
// CreateSession 只有 prompt/model/retryOf——没有 project/工作目录参数，任务包必须自带 worktree 绝对路径。
function agentProtocol() {
  const coder = builtinAgentPromptPath("coder")
  const reviewer = builtinAgentPromptPath("reviewer")
  return [
    "## 子智能体分配协议（编码/审查必须这样派，不要在自己会话内串行写码或审查）",
    "",
    "用你的 CreateSession 工具为编码与对抗审查各开一条独立根会话：",
    `1. 编码智能体提示词文件：${coder}`,
    `2. 审查智能体提示词文件：${reviewer}`,
    "3. CreateSession 只收 prompt/model/retryOf，没有 project/工作目录参数——新会话工作目录不可指定，任务包必须自带 worktree 绝对路径，让子智能体自己 cd。",
    "4. 子会话首句固定两段：第一段「先完整阅读你的提示词文件 <对应绝对路径>，严格遵照执行」；第二段注入任务包（工单键与链接、正文与验收标准、涉及工程及基线——含各工程 worktree 绝对路径与工作分支、补充约束、审查意见；审查会话则给 PR 列表与测试报告）。",
    "5. 等待用 WaitSessions（传 create 返回的 operation），读结果用 ReadSession（view=summary）。",
    "6. 同一工单始终复用同一条编码会话：审查有阻断时用 SendToSession 把审查 JSON 原文续说给原编码会话逐项修复，修复完成后重开审查会话复审。",
    "7. 会话工具不可用时才允许回退：改用 Agent 工具创建 sub agent，prompt 同样以「先完整阅读提示词文件 <绝对路径>」开头并注入相同任务包。",
  ].join("\n")
}

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
      agentProtocol(),
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
    // 目标会话已不存在（载体切换/会话被清）时立刻清掉死绑定：下一轮重试直接新建，
    // 不用干等 recreateAfterHours 的 24h stale——2026-11-23 切 zcode 载体时实测踩过。
    const targetMissing =
      e?.code === "session_missing" ||
      /侧边栏里没有任务|没找到这个会话|账本里没有会话/.test(String(e?.message ?? ""))
    saveRouterRecord(failed, {
      ...previous,
      ...(targetMissing ? { convId: "", name: "" } : {}),
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
