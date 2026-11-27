// router agent：接收未定向消息、巡检、接单与异常分派；Foreman 只负责持久投递和会话轮换。
import { Book } from "../book.mjs"
import { agentExecutor } from "./executors.mjs"
import { builtinAgentPromptPath } from "../builtin-prompts.mjs"
import { memoryBootstrap } from "./memory.mjs"

// 子智能体分配协议：编码/审查由 foreman 开独立工作会话（yolo，不卡审批，收工自动通知 router）。
// 不用 CreateSession：它开的子会话是 build 权限模式，每个改动都要审批，必然卡死（2026-11-27 实测）；
// 不用 Agent 工具：子代理一次性，审查-修复循环无法跨轮续说。
// 任务包写文件传 --task-file；delivered 会话无 --cwd，任务包必须自带 worktree 绝对路径。
function agentProtocol() {
  const coder = builtinAgentPromptPath("coder")
  const reviewer = builtinAgentPromptPath("reviewer")
  return [
    "## 子智能体分配协议（编码/审查必须这样派，不要在自己会话内串行写码或审查）",
    "",
    "**不要用 CreateSession**（它开的子会话是 build 权限模式，每个改动都要审批，必然卡死）**也不要用 Agent 工具**（子代理一次性，无法跨轮续说）。编码与审查一律用 foreman 开独立工作会话（yolo，不卡审批，收工自动通知你）：",
    "",
    "1. 任务包先写成文件（绝对路径）：工单键与链接、正文与验收标准、涉及工程及基线——含各工程 worktree 绝对路径与工作分支、补充约束；审查会话的则给 PR 列表与测试报告。",
    `2. 开编码会话：\`foreman session open --role coder --issue <owner/repo>#<单号> --repo <worktree 绝对路径> --task-file <任务包绝对路径>\`（coder 岗位提示词：${coder}，foreman 自动装配，工作目录就是 --repo）。`,
    `3. 开审查会话：同上把 --role 换成 reviewer（reviewer 岗位提示词：${reviewer}）。`,
    "4. **不要轮询等待结果**：会话收工时 foreman 自动把【工作会话状态变化】连同最终回复原文投进你的收件箱。期间响应用户新消息优先。",
    "5. 修复循环：审查有阻断时，把审查 JSON 原文用 `foreman steer <会话名> --text \"<审查意见>\"` 续给**原编码会话**逐项修复；修完再开新的审查会话复审。",
    "6. 同一工单始终复用同一条编码会话（用 steer 续），不要重复 open。",
    "7. 会话清单与实时状态看 `foreman tasks --json`；open/steer 报错（如 blocked=目标会话卡死）时按报错处理：解除阻塞或换新会话，不要反复重试同一个卡死的会话。",
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
  const { cfg, session } = ctx
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
    const opened = await session.openNew({ name, prompt: first, noWait: true })
    convId = String(opened?.convId ?? "").trim()
    if (!convId) throw new Error("新建 router agent 会话成功返回但没有 convId")
  } else {
    await session.queue(convId, text)
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
    if (typeof ctx.session?.openNew !== "function" || typeof ctx.session?.queue !== "function") {
      throw new Error("会话适配器缺少 openNew/queue，无法投递 router agent")
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
