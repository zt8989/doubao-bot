// 提示词与结果协议：会话里那个执行器必须交 RESULT 块，foreman 只认这个块。
import { slugify } from "./util.mjs"

export const RESULT_SPEC = `结束时（而且只在结束时）输出一个 RESULT 块，格式严格如下：
<RESULT>{"status":"done","branch":"<分支名>","tests":"<你跑过的测试命令与结果，一行>","summary":"<改了什么，50 字内>"}</RESULT>
status 只有四种：
- done：改完并自测通过，可以交 PR；
- need_decision：缺信息或需要人拍板，加 "question" 字段写清楚要问什么，不要猜；
- blocked：试过了做不了，summary 里写原因；
- failed：这次没做成但还能再试，summary 写卡在哪。
除 RESULT 块外不要在结尾再写别的。`

export function issueBranch(issue, title) {
  const hasCJK = /[\u3400-\u9fff]/.test(String(title ?? ""))
  const slug = hasCJK ? "" : slugify(title, 28)
  return `fix/issue-${issue.number}${slug ? "-" + slug : ""}`
}

export function kickoff({ repo, issue, worktree, branch, base, attempt = 1, lastFailure = "" }) {
  const rules = [
    `只在这个工作区里改：${worktree}`,
    `分支已经开好：${branch}（基线 origin/${base}）。不要切分支、不要 rebase、不要动别的目录。`,
    `不要 push、不要开 PR、不要合并、不要关闭工单——这些由 foreman 统一做。你只管改代码 + 本地提交。`,
    `提交信息用中文，首行写 “fix(#${issue.number}): <一句话>”，正文写清改法与验证方式。`,
    `先读仓库里的 AGENTS.md / docs/agents/ 约定（如果有），按仓库自己的规矩来。`,
    `改完必须自己跑相关测试；跑不了就在 tests 里写清原因，不要假装跑过。`,
  ]
  const lines = [
    `【foreman 接单 · ${repo} #${issue.number} · 第 ${attempt} 次】`,
    ``,
    `仓库：${repo}`,
    `工单：#${issue.number} ${issue.title}`,
  ]
  if (issue.url) lines.push(`工单链接：${issue.url}`)
  lines.push(
    ``,
    `工单正文：`,
    (issue.body ?? "").trim() || "（正文为空，按标题理解）",
    ``,
    `工作区：${worktree}`,
    `分支：${branch}`
  )
  if (lastFailure) lines.push(``, `上一次没成的反馈：${lastFailure}`)
  lines.push(``, `要求：`, ...rules.map((r, i) => `${i + 1}. ${r}`), ``, RESULT_SPEC)
  return lines.join("\n")
}

export function resume({ issue, attempt, failure = "" }) {
  return [
    `继续工单 #${issue.number}（第 ${attempt} 次尝试）。`,
    failure ? `上一次的问题：${failure}` : "上一次没有跑完，接着当前工作区状态继续，不要重做已完成的部分。",
    `还是那条边界：只改代码 + 本地提交，不 push、不开 PR、不关单。`,
    ``,
    RESULT_SPEC,
  ].join("\n")
}

export function handoff({ repo, issue, worktree, branch }) {
  return [
    `（接续 foreman 的接单会话：${repo}${issue ? ` #${issue.number}` : ""}）`,
    issue ? `工单：${issue.title}` : "",
    `工作区：${worktree}`,
    `分支：${branch}`,
    `进展都在这个工作区的提交里，先 git log / git status 看一眼再动手。`,
  ]
    .filter(Boolean)
    .join("\n")
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
    `- 由 foreman 自动接单产出：改动边界限定在 worktree 内，只做本地提交；没有 force push、没有手改基线。`,
    ``,
    `## 验收判据`,
    `- [x] 工作区干净（无未提交改动）`,
    `- [x] 分支有提交（origin/${base || "<base>"}..HEAD > 0）`,
    `- [ ] 人复核 diff`,
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
    if (parsed) return normalize(parsed, raw, block)
  }
  const loose = tryJson(raw)
  if (loose && loose.status) return normalize(loose, raw, JSON.stringify(loose))
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
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalize(o, raw, block) {
  const s = String(o.status ?? "").toLowerCase()
  let status = "failed"
  if (["done", "ok", "success", "finished", "complete"].includes(s)) status = "done"
  else if (["need_decision", "need-decision", "ask", "question", "needs_decision"].includes(s)) status = "need_decision"
  else if (["blocked", "block", "cannot"].includes(s)) status = "blocked"
  else if (["failed", "fail", "error"].includes(s)) status = "failed"
  return {
    status,
    branch: String(o.branch ?? ""),
    tests: String(o.tests ?? ""),
    summary: String(o.summary ?? o.note ?? ""),
    question: String(o.question ?? ""),
    raw,
    block,
  }
}
