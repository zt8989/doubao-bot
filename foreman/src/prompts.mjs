// 提示词与结果协议：会话里那个执行器必须交 RESULT 块，foreman 只认这个块。
import { slugify } from "./util.mjs"

export const RESULT_SPEC = `结束时（而且只在结束时）输出一个 RESULT 块，格式严格如下：
<RESULT>{"status":"done","branch":"<分支名>","pr":<PR 编号>,"prUrl":"<PR 链接>","tests":"<你跑过的测试命令与结果，一行>","summary":"<改了什么，50 字内>"}</RESULT>
status 只有四种：
- done：改完、自测通过、已经 push 并开了 PR（pr 与 prUrl 必填）；
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
    `改完并在本工作区自测通过后：先 git push -u origin ${branch}，再用 foreman pr open --repo ${repo} --base ${base} --head ${branch} --title "fix(#${issue.number}): <一句话>" --body "<自证正文>" --issue ${issue.number} 开 PR。PR 必须走 foreman（它记账、同步控制台），不要直接 opencli gitea pr；输出里的 pr 与 url 填进 RESULT 的 pr / prUrl。`,
    `自测没过就先别 push、别开 PR，按 status 交 RESULT 说明卡在哪。工单侧（评论/关单/改标签）可以直接 opencli gitea issue-comment|close|issue-edit，不经 foreman；但 PR 只能经 foreman pr open 建（绕过它这条 PR 就不进账本），合并由 foreman 做、你不要合。不要 force push、不要手改基线。`,
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

export function resume({ issue, attempt, base = "", failure = "" }) {
  return [
    `继续工单 #${issue.number}（第 ${attempt} 次尝试）。`,
    failure ? `上一次的问题：${failure}` : "上一次没有跑完，接着当前工作区状态继续，不要重做已完成的部分。",
    `还是那条边界：只在这个工作区改；自测通过后自己 git push + foreman pr open 开 PR（${base ? `--base ${base} ` : ""}--issue ${issue.number}），把 PR 号/链接写进 RESULT；建 PR 只走 foreman、不合并、不 force push。`,
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

// deliverPrompt：每次新建会话的首句 = 编排提示词（运行时副本，路径只从配置来）
// + 产品 + 监控项目 + 触发原因 + 本次通知正文。
// 关键：这是**编排**提示词，新会话只决定「续跑 / 继续接单 / 自动合并」，
// 不是「编排提示词 + 去完成这张工单」——实现永远在执行会话里，不在这条投递会话里。
export function deliverPrompt({ fixed = "", projectDir = "", product = "", kind = "", text = "", running = null, maxRunning = null } = {}) {
  const head = String(fixed ?? "").trim()
  if (!head) throw new Error("固定提示词为空：检查 deliver.promptFile / products[].promptFile 指向的文件")
  const body = String(text ?? "").trim()
  const online = []
  if (product) online.push(`产品：${String(product).trim()}`)
  if (projectDir) online.push(`监控项目：${String(projectDir).trim()}`)
  if (kind) online.push(`触发：${String(kind).trim()}`)
  if (Number.isFinite(running)) {
    online.push(`在跑任务：${running}${Number.isFinite(maxRunning) ? ` / 上限 ${maxRunning}` : ""}`)
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
    `- 由接单会话自行 push 并开 PR；改动边界限定在 worktree 内，没有 force push、没有手改基线；foreman 不合并。`,
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
    pr: Number(o.pr) > 0 ? Number(o.pr) : null,
    prUrl: String(o.prUrl ?? ""),
    tests: String(o.tests ?? ""),
    summary: String(o.summary ?? o.note ?? ""),
    question: String(o.question ?? ""),
    raw,
    block,
  }
}
