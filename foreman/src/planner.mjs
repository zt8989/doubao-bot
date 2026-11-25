// 续接调度：一个会话跑完、槽位空出来时，提醒编排 agent 继续接单；
// 跑完但不是 done，就提醒它去看怎么回事。纯函数负责判断与文案，取队列在服务层做。
import { eligible, sortIssues, issueKey, bucketOf } from "./orchestrator.mjs"
import { earliestCaller } from "./prwatch.mjs"

// pr-open 也算在跑：PR 开着还没关单，这张单仍占一条「自有工单」流程的名额，
// 不把 pr-open 算进来的话会出现第 3 条接单流程。
// handed 是「已经交给编排会话、等它 dispatch」：同样占槽，否则每轮巡检都会再交一次。
export const RUNNING_STATES = new Set(["handed", "planned", "working", "pr-open"])

// 正在跑的单：派出去还没出结论的（派单失败的不占槽，等重试）。
export function runningIssues(book) {
  return Object.entries(book?.issues ?? {})
    .filter(([, it]) => RUNNING_STATES.has(String(it?.state ?? "")))
    .map(([key, it]) => ({ key, ...it }))
}

// 占着槽位的单：planned/working 且不是「派单失败待重试」的那些。
export function inflightIssues(book) {
  return runningIssues(book).filter((it) => !it.lastFailure)
}

export function plannerTarget(cfg, book, env = process.env) {
  const raw = String(cfg?.planner?.target ?? "").trim()
  if (raw && raw !== "auto" && raw !== "earliest") return raw
  const caller = earliestCaller(book)
  if (caller) return caller
  return String(env.MCP_VM_CONVERSATION_ID ?? "").trim()
}

// 跑完这一条之后要不要提醒编排：开关 + 去重 + 槽位。
export function plannerDecision({ cfg, book, result, key }) {
  const p = cfg?.planner ?? {}
  if (p.enabled !== true) return { send: false, reason: "disabled" }
  if (!key) return { send: false, reason: "no-key" }
  if (book?.planner?.lastKey === key) return { send: false, reason: "already" }
  const running = inflightIssues(book).length
  const maxRunning = Number(p.maxRunning) || Number(cfg?.pickup?.maxRunning) || 2
  const status = String(result?.status ?? "")
  if (status !== "done") return { send: true, kind: "check", running, maxRunning, reason: "not-done" }
  if (running >= maxRunning) return { send: false, reason: `running-${running}` }
  return { send: true, kind: "continue", running, maxRunning }
}

// 队列：各仓库 open 工单里还能接的，按三档排序，截断到 limit。
export async function loadQueue({ cfg, book, gitea, limit = 5 }) {
  const items = []
  for (const repoCfg of cfg.repos ?? []) {
    const labelQuery = (repoCfg.labelIds ?? cfg.pickup?.labelIds ?? []).join(",")
    let list = []
    try {
      list = await gitea.listIssues(repoCfg.repo, { label: labelQuery })
    } catch {
      continue
    }
    const pool = sortIssues(eligible(list, repoCfg, cfg, book), cfg.pickup?.order ?? "oldest", {
      me: cfg.pickup?.me ?? "",
      priority: cfg.pickup?.priority ?? ["mine", "unassigned", "others"],
    })
    for (const it of pool) {
      items.push({ repo: repoCfg.repo, number: it.number, title: it.title ?? "", author: it.author ?? "", assignees: it.assignees ?? [] })
    }
  }
  return items.slice(0, limit)
}

export function queueLine(cfg, it) {
  // 标签和 bucketOf 一个口径：「我的」= 指派给我，不是作者是我。
  const tag = { mine: "我的", unassigned: "无人认领", others: "他人" }[bucketOf(it, cfg?.pickup?.me)] ?? "他人"
  return `- ${it.repo} #${it.number} 【${tag}】${it.title || ""}`
}

export function plannerText({ cfg, kind, watcher, result, running, maxRunning, issues = [] }) {
  const head = `【foreman】${watcher?.issueKey || `${watcher?.repo ?? ""}#${watcher?.number ?? ""}`}`
  if (kind === "check") {
    const lines = [
      `【foreman · 需要你看一下】${watcher?.issueKey || `${watcher?.repo ?? ""}#${watcher?.number ?? ""}`} 跑完但不是 done`,
      `执行会话：${watcher?.target ?? ""}${watcher?.name && watcher.name !== watcher.target ? `（${watcher.name}）` : ""}`,
      `状态：${result?.status ?? "无 RESULT"}`,
      result?.summary ? `原因：${String(result.summary).slice(0, 300)}` : "",
      result?.question ? `要问的：${String(result.question).slice(0, 300)}` : "",
      result?.branch ? `分支：${result.branch}` : "",
      result?.pr ? `PR：#${result.pr}${result.prUrl ? ` ${result.prUrl}` : ""}` : "",
      `处理：foreman tasks 看它在哪一步；确认可以再跑就 foreman retry ${(watcher?.repo ?? "").split("/")[1] || "<仓库>"} ${watcher?.number ?? ""}，否则按原因调整。`,
    ].filter(Boolean)
    return lines.join("\n")
  }
  const total = issues.length
  const lines = [
    `【foreman · 可以继续接单】槽位空着（在跑 ${running}/${maxRunning}），队列里还有 ${total} 条可接：`,
    ...issues.map((it) => queueLine(cfg, it)),
    `继续跑：foreman run --once（或常驻 foreman run --every 1800）`,
  ]
  return lines.join("\n")
}
