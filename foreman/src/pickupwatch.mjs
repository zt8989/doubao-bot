// 我的工单扫描：只筛选「指派给 pickup.me 且带 ready-for-agent」的 open 工单。
// 候选写入 router.notice Inbox，由 router agent 核对容量后 hand；这里不派单、不建工作区、不开会话。
import { nowIso } from "./util.mjs"
import { Book } from "./book.mjs"
import { eligible, sortIssues } from "./orchestrator.mjs"

export const READY_FOR_AGENT = "ready-for-agent"

export function assignedToMe(issue, me) {
  const account = String(me ?? "").trim()
  return Boolean(account && (issue?.assignees ?? []).map((x) => String(x).trim()).includes(account))
}

export function hasReadyLabel(issue) {
  return (issue?.labels ?? []).map((x) => String(x).trim().toLowerCase()).includes(READY_FOR_AGENT)
}

export function pickupInspectorText(issues = [], cfg = {}) {
  const me = String(cfg?.pickup?.me ?? "").trim()
  const lines = [
    "【Foreman · router agent · 我的 ready-for-agent 工单待分配】",
    `代码已筛选 open、指派给 ${me} 且带 ready-for-agent 的工单，并排除了账本中已在处理或已收口的单。`,
    "请先运行 foreman tasks --json 核对未收口数量、现有会话和容量；有容量时按现有优先级逐条执行下面的 hand 命令，由工单主智能体在 Agent 内创建内部编码 sub agent，不经 Foreman 分配编码会话。",
    "不要在扫描器之外重复派单；容量已满时不要 hand，候选会在后续扫描中继续提醒。",
  ]
  for (const issue of issues) {
    lines.push("")
    lines.push(`· ${issue.repo}#${issue.number} ${issue.title ?? ""}`.trim())
    if (issue.url) lines.push(`  链接：${issue.url}`)
    lines.push(`  接单：foreman hand ${issue.repo}#${issue.number}`)
  }
  return lines.join("\n")
}

export async function pickupWatchOnce({ cfg, gitea, log = () => {}, inspect = null }) {
  const me = String(cfg?.pickup?.me ?? "").trim()
  if (!me) return { ok: false, error: "pickup.me 未配置，无法筛选指派给我的工单" }

  const book = new Book(cfg.stateFile)
  const fresh = []
  const errors = []
  let checked = 0

  for (const repoCfg of cfg.repos ?? []) {
    const label = (repoCfg.labelIds ?? cfg.pickup?.labelIds ?? []).join(",") || READY_FOR_AGENT
    let list = []
    try {
      list = await gitea.listIssues(repoCfg.repo, { label })
    } catch (error) {
      errors.push({ repo: repoCfg.repo, message: error.message })
      log(`我的工单扫描 ${repoCfg.repo} 失败：${error.message}`)
      continue
    }
    checked += list.length
    const pool = sortIssues(eligible(list, repoCfg, cfg, book), cfg.pickup?.order, {
      me,
      priority: cfg.pickup?.priority,
    })
    for (const issue of pool) {
      // 自动接单只认指派人，不把「作者是我」或「无人认领」当作我的工单。
      if (String(issue.state ?? "open").toLowerCase() !== "open") continue
      if (!assignedToMe(issue, me) || !hasReadyLabel(issue)) continue
      const key = `${repoCfg.repo}#${issue.number}`
      const state = book.issue(key)?.state
      // planned 已由 router/人工列入计划，handed 已交编排；二者都不需要重复提醒。
      if (state === "planned" || state === "handed") continue
      fresh.push({ ...issue, repo: repoCfg.repo, key })
    }
  }

  const candidates = fresh.map((issue) => ({
    key: issue.key,
    repo: issue.repo,
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    url: String(issue.url ?? ""),
    assignees: [...(issue.assignees ?? [])],
    labels: [...(issue.labels ?? [])],
    createdAt: String(issue.createdAt ?? ""),
  }))
  if (!candidates.length) return { ok: true, checked, notified: 0, pending: 0, issues: [], errors }
  if (typeof inspect !== "function") {
    return { ok: true, checked, notified: 0, pending: candidates.length, failedNotify: true, issues: [], errors }
  }

  try {
    const out = await inspect({
      type: "issue.candidates",
      text: pickupInspectorText(fresh, cfg),
      json: { issues: candidates },
    })
    if (out?.ok === false || out?.skipped) throw new Error(out.error || `router agent 接收工单候选失败：${out.skipped}`)
    log(`我的工单扫描：${candidates.length} 条候选已写入 router agent Inbox（${candidates.map((x) => x.key).join("、")}）`)
    return {
      ok: true,
      checked,
      notified: candidates.length,
      pending: 0,
      issues: candidates.map((x) => x.key),
      errors,
      at: nowIso(),
    }
  } catch (error) {
    log(`我的工单扫描：候选写入 Inbox 失败，下轮重试：${error.message}`)
    return { ok: true, checked, notified: 0, pending: candidates.length, failedNotify: true, issues: [], errors }
  }
}
