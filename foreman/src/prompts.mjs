// 提示词与结果协议：会话里那个执行器必须交 RESULT 块，foreman 只认这个块。
import { slugify } from "./util.mjs"
import { builtinPrompt } from "./builtin-prompts.mjs"

export const RESULT_SPEC = `结束时（而且只在结束时）输出一个 RESULT 块，格式严格如下：
<RESULT>{"status":"done","tests":"<你跑过的测试命令与结果，一行>","summary":"<改了什么，50 字内>"}</RESULT>
status 只有四种：
- done：改完、自测通过、已经 commit（工作区里不留未提交改动）。push、开 PR、合并、关工单都不用你做，也别往 RESULT 里写 prs；
- need_decision：缺信息或需要人拍板，加 "question" 字段写清楚要问什么，不要猜；
- blocked：试过了做不了，summary 里写原因；要改的工程没有工作区也算 blocked，summary 写「缺工作区：<owner/name>」；
- failed：这次没做成但还能再试，summary 写卡在哪。
除 RESULT 块外不要在结尾再写别的。`

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
    `一工程一工作区：只在自己那条工作区里改（上面按工程列好了）。不要跨到别的工程目录，也不要动各仓库的主 checkout、不要动别的目录。`,
    `要改的工程不在上面：先别动手，交 blocked，summary 写「缺工作区：<owner/name>」——工作区由外面补开，你不用自己开，也不要在主 checkout 里改。`,
    `改完就 commit，然后结束。提交完就停：不要 push、不要开 PR、不要合并、不要关工单、不要动 worktree 或会话——push、PR、合并、收尾都由外面做。`,
    `提交信息用中文，首行写 “fix(#${issue.number}): <一句话>”，正文写清改法与验证方式。工作区里不要留未提交的改动。`,
    `想多看工单细节可以读：opencli gitea issue-view --repo ${repo} ${issue.number}（只读，别改工单）。`,
    `先读各仓库里的 AGENTS.md / docs/agents/ 约定（如果有），按仓库自己的规矩来。`,
    multi
      ? `改完必须自己在每个动过的工程里跑相关测试；某个工程跑不了就在 tests 里写清是哪个工程、为什么，不要假装跑过。`
      : `改完必须自己跑相关测试；跑不了就在 tests 里写清原因，不要假装跑过。`,
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
    lines.push(``, `这些工程的工作区没建成（要改就先交 blocked，summary 写「缺工作区：<owner/name>」，工作区由外面补开）：`, ...failedWorkspaces.map((f) => `- ${f.repo}：${f.error}`))
  }
  if (lastFailure) lines.push(``, `上一次没成的反馈：${lastFailure}`)
  lines.push(``, `要求：`, ...rules.map((r, i) => `${i + 1}. ${r}`), ``, RESULT_SPEC)
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
    `1. 先读工单与评论（opencli gitea issue-view --repo ${repo} ${issue.number}），必要时翻代码，弄清它到底要什么。`,
    `2. 信息不够、或有多种合理做法：不要猜、不要硬做。写清缺什么信息、有哪些方案、你推荐哪个；需要人回答的，用 opencli gitea issue-comment 回到工单上。`,
    `3. 判断下来确实能做、做法也明确：可以直接做。只在自己那条工作区里改，改完自己跑相关测试并 commit；不要 push、不要开 PR、不要合并、不要关工单。`,
    `4. 判断下来不该做（重复、已解决、方向不对）：说明理由并给出建议，但不要自己关单、不要自己改标签。`,
    `5. 这次没有人监听你跑完后的状态：结论、疑问、建议都要在会话里写完整，别只丢一个 RESULT 块。`
  )
  if (list.length) {
    lines.push(
      ``,
      `工作区（一工程一个，别跨目录、别动各仓库主 checkout）：`,
      ...list.flatMap((w, i) => [
        `${i + 1}. ${w.repo}`,
        `   工作区：${w.worktree}`,
        `   分支：${w.branch}（基线 origin/${w.base || base}）`,
      ])
    )
  }
  lines.push(``, RESULT_SPEC)
  return lines.join("\n")
}

export function resume({ issue, attempt, base = "", failure = "", repo = "", workspaces }) {  const list = normalizeWorkspaces({ repo, workspaces })
  const where = list.length
    ? `一个工程一个工作区：${list.map((w) => `${w.repo} → ${w.worktree}（${w.branch}）`).join("；")}`
    : "一工程一工作区：每个工程只在自己的工作区里改"
  return [
    `继续工单 #${issue.number}（第 ${attempt} 次尝试）。`,
    failure ? `上一次的问题：${failure}` : "上一次没有跑完，接着当前工作区状态继续，不要重做已完成的部分。",
    `${where}。要改的工程还没有工作区，交 blocked 并在 summary 写「缺工作区：<owner/name>」，别跨目录、别在主 checkout 里改。`,
    `改完就 commit，然后结束：不要 push、不要开 PR、不要合并、不要关工单、不要动 worktree 或会话。`,
    ``,
    RESULT_SPEC,
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
    "按上面的编排提示词做决定，不要亲手实现工单。",
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

// 合并助手旧提示词没有写清多条 PR 的格式，可能直接交顶层数组。
// 新提示词统一用 { items: [...] }；这里兼容旧结果，避免已完成的判断卡死、永远不触发自动合并。
function normalizeParsed(parsed, raw, block) {
  if (!Array.isArray(parsed)) return normalize(parsed, raw, block)
  const rows = parsed.filter((it) => it && typeof it === "object" && !Array.isArray(it))
  if (!rows.length) return { status: "none", raw, text: raw.trim() }
  const items = rows.map(normalizeItem).filter((it) => it.repo || it.pr)
  const status = rows.every((it) => String(it.status ?? "").trim() === "done")
    ? "done"
    : String(rows.find((it) => String(it.status ?? "").trim() !== "done")?.status ?? "failed")
  const mergeable = items.some((it) => it.mergeable === true) ? true
    : items.some((it) => it.mergeable === false) ? false : null
  const summary = rows.map((it) => String(it.summary ?? "").trim()).filter(Boolean).join("；")
  const tests = rows.map((it) => String(it.tests ?? "").trim()).filter(Boolean).join("；")
  const question = rows.map((it) => String(it.question ?? "").trim()).find(Boolean) ?? ""
  return normalize({ status, mergeable, items: rows, summary, tests, question }, raw, block)
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
    // 合并助手的结论字段：派单会话不填，但解析时一并带出来，
    // 「读 RESULT 决定合不合」的地方就不用再自己抠原文。
    mergeable: truthOf(o.mergeable),
    conflict: String(o.conflict ?? "").trim(),
    repo: String(o.repo ?? "").trim(),
    base: String(o.base ?? "").trim(),
    merged: truthOf(o.merged) === true,
    items: Array.isArray(o.items) ? o.items.map(normalizeItem).filter((it) => it.repo || it.pr) : [],
    raw,
    block,
  }
}

// 逐条结论（合并助手一次交多条 PR）：只留判断要用的几个字段。
function normalizeItem(it) {
  const o = it ?? {}
  const pr = Number(o.pr) > 0 ? Number(o.pr) : null
  return {
    status: String(o.status ?? "").trim(),
    repo: String(o.repo ?? "").trim(),
    pr,
    prUrl: String(o.prUrl ?? ""),
    mergeable: truthOf(o.mergeable),
    conflict: String(o.conflict ?? "").trim(),
    reason: String(o.reason ?? o.summary ?? "").trim(),
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

// truthOf：布尔/字符串都认（"true"/"1"/"yes"），没填返回 null——「没表态」不等于「可以合」。
function truthOf(v) {
  if (v === undefined || v === null || v === "") return null
  if (v === true || v === false) return v
  const t = String(v).trim().toLowerCase()
  if (["true", "1", "yes", "y", "可以", "可合", "mergeable"].includes(t)) return true
  if (["false", "0", "no", "n", "不可以", "不可合"].includes(t)) return false
  return null
}
