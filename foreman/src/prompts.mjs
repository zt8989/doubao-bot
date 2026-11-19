// 提示词与结果采集：执行会话只提交代码并给普通最终回复，业务结论由编排智能体判断。
import { slugify } from "./util.mjs"
import { builtinPrompt } from "./builtin-prompts.mjs"

export const FINAL_REPLY_SPEC = `结束时直接给出最终回复，用自然语言写清三件事：
- 改了什么、提交是什么；
- 跑过哪些测试及结果；跑不了就说明原因；
- 未能完成时，写清缺少的信息、阻塞原因或下一步建议。
最终结果由编排智能体结合提交、diff、测试和工单统一判断。`

export function issueBranch(issue, title) {
  const hasCJK = /[\u3400-\u9fff]/.test(String(title ?? ""))
  const slug = hasCJK ? "" : slugify(title, 28)
  return `fix/issue-${issue.number}${slug ? "-" + slug : ""}`
}

// 一工程一工作区：workspaces 是这次派单实际建好的工作区（每个工程一条）。
// 老调用方只传 worktree/branch 时按单工程处理。
function normalizeWorkspaces({ repo, worktree, branch, base, workspaces } = {}) {
  const list = Array.isArray(workspaces) && workspaces.length ? workspaces : [{ repo, worktree, branch, base }]
  return list.filter((w) => w?.repo && (w?.worktree || w?.branch))
}

export function kickoff({ repo, issue, worktree, branch, base, workspaces, failedWorkspaces = [], attempt = 1, lastFailure = "" }) {
  const list = normalizeWorkspaces({ repo, worktree, branch, base, workspaces })
  const multi = list.length > 1
  const key = `${repo}#${issue.number}`
  const baseOf = (w) => w.base || base
  const rules = [
    `一工程一工作区：只在自己那条工作区里改（上面按工程列好了）；各仓库主 checkout 和其他目录保持原样。`,
    `要改的工程不在上面：停手，在最终回复里写清「缺工作区：<owner/name>」，工作区由外面补开。`,
    `改完就 commit，然后结束本轮：push、开 PR、合并、关工单、动 worktree 由外部流程接手。`,
    `提交信息用中文，首行写 “fix(#${issue.number}): <一句话>”，正文写清改法与验证方式；工作区保持干净，手上有改动就一并提交。`,
    `工单、分支、PR 用 Gitea CLI 查（只读）：gitea issue-view --repo ${repo} ${issue.number} 看工单与评论，gitea search --repo ${repo} 列工单，gitea pull-list --repo ${repo} 看相关 PR；令牌自动取（GITEA_TOKEN 或本机默认凭据文件）。查完就回到改代码、跑测试、commit；写工单、push、PR、合并、收口由外部流程执行。`,
    `先读各仓库里的 AGENTS.md / docs/agents/ 约定（如果有），按仓库自己的规矩来。`,
    multi
      ? `改完必须自己在每个动过的工程里跑相关测试；某个工程跑不了就在最终回复里写清是哪个工程、为什么。`
      : `改完必须自己跑相关测试；跑不了就在最终回复里写清原因。`,
  ]
  const lines = [
    `【工作会话 · ${key} · 第 ${attempt} 次】`,
    `工单键：${key}`,
    `工单链接：${issue.url || "（未提供）"}`,
    ``,
    `工单：#${issue.number} ${issue.title}`,
  ]
  lines.push(
    ``,
    `工单正文：`,
    (issue.body ?? "").trim() || "（正文为空，按标题理解）",
    ``,
    `一工程一工作区（本单 ${list.length} 个工程，各自一个工作区、互不共用）：`,
    ...list.flatMap((w, i) => [
      `${i + 1}. ${w.repo}`,
      `   工作区：${w.worktree}`,
      `   分支：${w.branch}（基线 origin/${baseOf(w)}）`,
    ])
  )
  if (failedWorkspaces.length) {
    lines.push(``, `这些工程的工作区没建成（要改就在最终回复里写清「缺工作区：<owner/name>」，工作区由外面补开）：`, ...failedWorkspaces.map((f) => `- ${f.repo}：${f.error}`))
  }
  if (lastFailure) lines.push(``, `上一次没成的反馈：${lastFailure}`)
  lines.push(``, `要求：`, ...rules.map((r, i) => `${i + 1}. ${r}`), ``, FINAL_REPLY_SPEC)
  return lines.join("\n")
}

// 「决策单」提示词：带 needs-info / needs-human / ready-for-human / wontfix / agent-blocked 这类标签的工单，
// 手动接单时不按「改完 commit」派，而是让 agent 自己判断该不该做、怎么做。
// 这类单不登记监听、不绑编排会话：没有人在它跑完后接结果，所以结论必须在会话里写完整。
export function decisionKickoff({ repo, issue, base, workspaces = [], labels = [], attempt = 1 }) {
  const list = normalizeWorkspaces({ repo, base, workspaces })
  const key = `${repo}#${issue.number}`
  const lines = [
    `【决策会话 · ${repo} #${issue.number} · 第 ${attempt} 次】`,
    ``,
    `工单：#${issue.number} ${issue.title}`,
  ]
  if (issue.url) lines.push(`工单链接：${issue.url}`)
  lines.push(`工单键：${key}`)
  if (labels.length) lines.push(`当前标签：${labels.join("、")}`)
  lines.push(
    ``,
    `工单正文：`,
    (issue.body ?? "").trim() || "（正文为空，按标题理解）",
    ``,
    `这张单带着「需要人参与 / 信息不足」类标签，所以这次不是直接派活，是请你先判断再决定动不动手：`,
    `1. 先读工单与评论（gitea issue-view --repo ${repo} ${issue.number}），必要时翻代码，弄清它到底要什么。`,
    `2. 信息不够、或有多种合理做法：先把缺的信息、可选方案和你的推荐写清楚；需要人回答的，用 gitea issue-comment 回到工单上，等答复再动手。`,
    `3. 判断下来确实能做、做法也明确：直接在指定工作区里做，改完自己跑相关测试并 commit，结束本轮；push、开 PR、合并、关工单由外部流程接手。`,
    `4. 判断下来不该做（重复、已解决、方向不对）：说明理由并给出建议，工单状态与标签保持原状，由人工处理。`,
    `5. 这次没有人监听你跑完后的状态：结论、疑问、建议都写在会话里，写清依据和下一步。`
  )
  if (list.length) {
    lines.push(
      ``,
      `工作区（一工程一个，各自独立，各仓库主 checkout 保持原样）：`,
      ...list.flatMap((w, i) => [
        `${i + 1}. ${w.repo}`,
        `   工作区：${w.worktree}`,
        `   分支：${w.branch}（基线 origin/${w.base || base}）`,
      ])
    )
  }
  lines.push(``, FINAL_REPLY_SPEC)
  return lines.join("\n")
}

export function resume({ issue, attempt, base = "", failure = "", repo = "", workspaces }) {  const list = normalizeWorkspaces({ repo, workspaces })
  const where = list.length
    ? `一个工程一个工作区：${list.map((w) => `${w.repo} → ${w.worktree}（${w.branch}）`).join("；")}`
    : "一工程一工作区：每个工程只在自己的工作区里改"
  return [
    `继续工单 #${issue.number}（第 ${attempt} 次尝试）。`,
    failure ? `上一次的问题：${failure}` : "上一次没有跑完，接着当前工作区状态继续，已完成的提交直接沿用。",
    `${where}。要改的工程还没有工作区：在最终回复里写清「缺工作区：<owner/name>」，改动落在指定工作区内。`,
    `改完就 commit，然后结束本轮；push、开 PR、合并、关工单、worktree 由外部流程接手。`,
    ``,
    FINAL_REPLY_SPEC,
  ].join("\n")
}

export function handoff({ repo, issue, worktree, branch, workspaces }) {
  const list = normalizeWorkspaces({ repo, worktree, branch, workspaces })
  return [
    `（接续 foreman 的接单会话：${repo}${issue ? ` #${issue.number}` : ""}）`,
    issue ? `工单：${issue.title}` : "",
    `一工程一工作区（各改各的）：`,
    ...list.map((w) => `- ${w.repo} → ${w.worktree}（${w.branch}）`),
    `进展都在各工作区的提交里，先 git log / git status 看一眼再动手。`,
  ]
    .filter(Boolean)
    .join("\n")
}

// deliverPrompt：每次新建会话的首句 = 编排提示词（配置给了路径就读运行时副本，没给用内置的）
// + 产品 + 监控项目 + 触发原因 + 本次通知正文。
// 关键：这是**编排**提示词，新会话只决定「续跑 / 继续接单 / 判合并」，
// 不是「编排提示词 + 去完成这张工单」——实现永远在执行会话里，不在这条投递会话里。
export function deliverPrompt({ fixed = "", projectDir = "", product = "", kind = "", text = "", running = null, maxRunning = null, lane = "" } = {}) {
  const laneName = lane === "merge" ? "merge" : "dispatch"
  const head = String(fixed ?? "").trim() || builtinPrompt(laneName).trim()
  const body = String(text ?? "").trim()
  const online = []
  if (product) online.push(`产品：${String(product).trim()}`)
  if (projectDir) online.push(`监控项目：${String(projectDir).trim()}`)
  if (kind) online.push(`触发：${String(kind).trim()}`)
  if (lane === "merge") online.push("通道：合并（1 并发，只管合 PR）")
  else if (lane === "dispatch" && Number.isFinite(running)) {
    online.push(`通道：派单（agent 主动派单不限在跑上限；当前在跑 ${running}${Number.isFinite(maxRunning) ? `；定时巡检上限 ${maxRunning}` : ""}）`)
  }
  return [
    head,
    "",
    "---",
    "",
    ...(online.length ? [...online, ""] : []),
    // 角色与三条路已经在编排提示词（上面的 MD）里写过了，这里只点一下入口，不再复述一遍。
    "按上面的编排提示词做决定，实现交给工作会话。",
    "下面是本次通知的上下文（只是决策输入，不是派给你的实现任务）：",
    "",
    body,
  ].join("\n")
}

// noticeSessionName：新建会话的名字（豆包侧边栏标题），带上投递类型与时间，便于复查。
export function noticeSessionName({ prefix = "foreman", kind = "", at = new Date() } = {}) {
  const d = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date()
  const p = (n) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  const label = String(kind ?? "").trim()
  const base = String(prefix ?? "foreman").trim() || "foreman"
  return label ? `${base}-${label}-${stamp}` : `${base}-${stamp}`
}

export function prBody({ issue, summary, tests, commits, stat, base = "" }) {
  return [
    `Closes #${issue.number}`,
    ``,
    `## Summary`,
    summary || "（会话未给出摘要）",
    ``,
    `## 提交与范围`,
    "```",
    commits || "（无）",
    "```",
    stat ? ["```", stat, "```"].join("\n") : "",
    ``,
    `## 自证`,
    tests ? `- 测试：${tests}` : "- 测试：会话未报告，人工复核",
    ``,
    `## Merge Danger`,
    `- 由接单会话自行 push 并开 PR；一工程一工作区，改动只落在该工程自己的 worktree 内，没有 force push、没有手改基线；foreman 不合并。`,
    ``,
    `## 验收判据`,
    `- [x] 工作区干净（无未提交改动）`,
    `- [x] 分支已推送、PR 已开（base ${base || "<base>"}）`,
    `- [ ] 人复核 diff 后决定是否合并`,
  ]
    .filter((l) => l !== "")
    .join("\n")
}

export function doneComment({ pr, tests, summary }) {
  return [
    `foreman 已接单完成：`,
    ``,
    `- PR：#${pr?.number ?? "?"}${pr?.url ? ` ${pr.url}` : ""}`,
    `- 摘要：${summary || "（无）"}`,
    tests ? `- 测试：${tests}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function holdComment({ status, note, question, worktree }) {
  const head = status === "need_decision" ? "这条单需要人拍板，先挂起：" : "这条单卡住了，先挂起："
  return [
    head,
    ``,
    question || note || "（会话没给出原因）",
    ``,
    `工作区留着：\`${worktree}\``,
    `人处理完后放回队列：\`foreman retry <仓库名> ${""}#<工单号>\``,
  ].join("\n")
}

// parseResult 只取最后一个 RESULT 块；兼容 ```json 包一层和裸 JSON。
export function parseResult(text) {
  const raw = String(text ?? "")
  const block = lastResultBlock(raw)
  if (block) {
    const parsed = tryJson(block)
    if (parsed) return normalizeParsed(parsed, raw, block)
  }
  const loose = tryJson(raw)
  if (loose && (Array.isArray(loose) || loose.status)) return normalizeParsed(loose, raw, JSON.stringify(loose))
  return { status: "none", raw, text: raw.trim() }
}

function lastResultBlock(raw) {
  const re = /<RESULT>([\s\S]*?)<\/RESULT>/gi
  let m
  let last = null
  while ((m = re.exec(raw))) last = m[1]
  return last
}

function tryJson(s) {
  let t = String(s).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const objectAt = t.indexOf("{")
  const arrayAt = t.indexOf("[")
  const start = objectAt < 0 ? arrayAt : arrayAt < 0 ? objectAt : Math.min(objectAt, arrayAt)
  if (start < 0) return null
  const end = t.lastIndexOf(t[start] === "[" ? "]" : "}")
  if (end < start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

// 工作会话的结果必须是一个 JSON 对象；旧的合并助手数组结论不再转换或消费。
function normalizeParsed(parsed, raw, block) {
  if (Array.isArray(parsed)) return { status: "none", raw, text: raw.trim() }
  return normalize(parsed, raw, block)
}

function normalize(o, raw, block) {
  const s = String(o.status ?? "").toLowerCase()
  let status = "failed"
  if (["done", "ok", "success", "finished", "complete"].includes(s)) status = "done"
  else if (["need_decision", "need-decision", "ask", "question", "needs_decision"].includes(s)) status = "need_decision"
  else if (["blocked", "block", "cannot"].includes(s)) status = "blocked"
  else if (["failed", "fail", "error"].includes(s)) status = "failed"
  // 一工程一工作区：动过几个工程就交几条 prs；老格式只写 pr/prUrl 的也认。
  const prs = Array.isArray(o.prs) ? o.prs.map(normalizePr).filter((p) => p.repo && p.pr) : []
  let pr = Number(o.pr) > 0 ? Number(o.pr) : null
  let prUrl = String(o.prUrl ?? "")
  let branch = String(o.branch ?? "")
  if (prs.length) {
    const first = prs.find((p) => p.pr) ?? prs[0]
    if (!pr) pr = first.pr
    if (!prUrl) prUrl = first.prUrl ?? ""
    if (!branch) branch = first.branch ?? ""
  }
  return {
    status,
    branch,
    pr,
    prUrl,
    tests: String(o.tests ?? ""),
    summary: String(o.summary ?? o.note ?? ""),
    question: String(o.question ?? ""),
    prs,
    raw,
    block,
  }
}

// 执行会话交的 prs[]：一个工程一条。
function normalizePr(it) {
  const o = it ?? {}
  const pr = Number(o.pr) > 0 ? Number(o.pr) : null
  return {
    repo: String(o.repo ?? "").trim(),
    branch: String(o.branch ?? "").trim(),
    pr,
    prUrl: String(o.prUrl ?? "").trim(),
  }
}
