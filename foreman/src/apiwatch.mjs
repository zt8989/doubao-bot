// 存量接口变更巡检：定时扫已合并 PR，diff 粗筛出触及接口定义文件的候选，
// 交独立的判官 agent 会话精判「是否改了存量接口出入参」，确认的发飞书群。
// 本文件只做确定性部分（列 PR、拉 diff、文件路径粗筛、账本去重）；语义判断全在判官提示词里。
import { Book } from "./book.mjs"
import { nowIso } from "./util.mjs"

// 默认粗筛模式：diff 文件路径含这些子串才算候选（大小写不敏感）。
// 保守偏接口定义文件：宁可漏一点也别把判官喂成垃圾场；cfg.apiWatch.include 可整体覆盖。
const DEFAULT_INCLUDE = [
  "controller",
  "dto",
  "/req",
  "/resp",
  "request",
  "response",
  "param",
  "api.ts",
  "api.js",
  "routes/",
  "schema",
  "proto",
  "openapi",
  "feign",
  "message",
  "event.ts",
  "event.js",
]

const DEFAULTS_SHAPE = {
  enabled: false,
  chatIds: [],
  repos: [],
  maxPages: 3,
  maxPrsPerRound: 5,
  maxProcessPerRound: 20,
  maxDiffChars: 6000,
  include: DEFAULT_INCLUDE,
}

function apiWatchSection(cfg) {
  const raw = cfg.apiWatch ?? {}
  return { ...DEFAULTS_SHAPE, ...raw }
}

// diff 里出现的文件路径（+++ b/path 行）；新文件 --- /dev/null +++ b/path 也在内。
export function diffFiles(diff) {
  return [...String(diff ?? "").matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim())
}

export function touchesInterface(diff, include) {
  const patterns = (include?.length ? include : DEFAULT_INCLUDE).map((p) => String(p).toLowerCase())
  return diffFiles(diff).some((file) => {
    const f = file.toLowerCase()
    return patterns.some((p) => f.includes(p))
  })
}

const truncate = (text, max) => {
  const s = String(text ?? "")
  return s.length <= max ? s : `${s.slice(0, max)}\n…（diff 已截断，全量看 PR 页面）`
}

function candidateText(candidates, chatIds) {
  const lines = candidates.map(
    (c) => `- ${c.repo}#${c.number} ${c.title}（${c.author || "未知作者"}，合并于 ${c.mergedAt || "未知时间"}）`
  )
  return [
    `【存量接口变更巡检】${candidates.length} 条合并 PR 疑似改了接口定义文件，待判官精判：`,
    ...lines,
    `目标群 ${chatIds.length} 个；确认变更的 PR 会由判官发群通知，无变更的静默。`,
  ].join("\n")
}

// 判官提示词：diff 全量内嵌（已截断），判官只做判断与发通知，不碰代码。
// 通知受众是外部联调用户：只认对外接口（JWT/token 鉴权、外部系统直接调用的端点），
// 内部逻辑变更（自家前端端点、模型面工具、框架内部行为）一律不通知。
export function judgePrompt({ prs, chatIds }) {
  const blocks = prs.map((p) => `### ${p.repo}#${p.number} ${p.title}
作者：${p.author || "未知"} · 合并于：${p.mergedAt || "未知"}
${p.url || ""}

\`\`\`diff
${p.diff ?? "（diff 拉取失败，按无变更处理并在总结里注明）"}
\`\`\``)
  return `# 对外接口变更判官

你是 Foreman 的对外接口变更审查员。通知受众是**外部联调用户**（拿 JWT/token 调我们接口的外部系统），他们不关心内部实现。本轮唯一任务：逐条判断下面的合并 PR 是否改了**对外接口**的出入参，确认的用 foreman send 发飞书群。不做其他动作，不要派子会话，不要改任何文件。

## 判断标准（从严：拿不准就不通知，外部用户被误扰的代价高于漏报）
- 只有**外部联调用户直接调用的对外接口**的出入参变更才算：走 JWT/token 鉴权、对外文档化的 HTTP 端点（或对外 SDK 方法）的入参、出参、必填性、类型、默认值语义、响应结构变化。
- 以下都属于**内部逻辑变更，一律不通知**：
  - 自家前端/管理端消费的端点（session/cookie 鉴权、内部接口、控制台接口）；
  - 模型面/Agent 工具（read_file、ask_kb 之类）的行为、出参、错误口径变化；
  - 框架内部类与方法签名（如 UserWorkspace.frameworkPath()）、内部消息/事件载荷、守卫/投影等内部机制；
  - 纯内部重构、注释、日志、内部命名。
- 从 diff 识别对外接口的线索：JWT/token 鉴权相关注解或过滤器、对外 API 文档、对外开放模块的 Controller；diff 里看不出鉴权方式或判断不了是否对外暴露时，按「不通知」处理。

## 发群通知（只对确认的对外接口变更）
每条确认变更的 PR 执行一次：
  foreman send --type feishu --chat-id <chatId> --markdown "<说明>" --dedupe-key apiwatch:<repo>#<序号>

- chatId 用下面给出的（逐字照抄）；dedupe-key 保证重跑不重发。
- 说明格式：
  【对外接口变更】<repo>#<序号> <标题>
  变更点：<哪个接口，入参/出参怎么变，逐条列出>
  影响：<外部联调方需要怎么适配>
  PR：<链接>
- 内部逻辑变更的 PR 不发任何消息。

## 目标群 chatId（逐字使用）
${chatIds.map((id) => `- ${id}`).join("\n")}

## 待审 PR
${blocks.join("\n\n")}

## 最后
全部处理完，回一句话总结：确认对外接口变更 X 条（已发群）、内部/无变更 Y 条（未发）。
`
}

// 一次性判官会话名（同 runAgentSchedule 的命名口径）。
export function judgeSessionName(at = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `foreman-接口巡检-${stamp}`
}

// Worker 直连处理器：把候选事件投给一条独立判官会话（yolo TUI，openNew 同 runAgentSchedule）。
// spawn 失败 throw → Inbox fail() 自动重试；重跑重复通知由 outbox dedupeKey 兜底。
export async function deliverApiBreakCandidates(ctx, event) {
  const payload = event?.payload ?? {}
  const prs = Array.isArray(payload.prs) ? payload.prs : []
  const chatIds = (Array.isArray(payload.chatIds) ? payload.chatIds : []).map((id) => String(id).trim()).filter(Boolean)
  if (!prs.length || !chatIds.length) return { ok: true, skipped: "empty" }
  const name = judgeSessionName()
  const delivered = await ctx.session.openNew({ name, prompt: judgePrompt({ prs, chatIds }), noWait: true })
  if (delivered?.ok === false) throw new Error(delivered.error || "判官会话投递失败")
  ctx.log?.(`接口变更判官会话已启动：${name}（${prs.length} 条候选）`)
  return { ok: true, spawned: name, convId: String(delivered?.convId ?? "") }
}

// 脚本执行器（Schedule apiWatch）：一轮 = 列合并 PR → 拉 diff → 粗筛 → 候选写 Inbox。
export async function apiWatchOnce(ctx, { force = false } = {}) {
  const { state, cfg, gitea, log } = ctx
  const section = apiWatchSection(cfg)
  if (section.enabled === false && !force) return { ok: true, skipped: "disabled" }
  if (!section.chatIds.length) return { ok: true, skipped: "no-chat-ids" }
  if (!gitea || typeof gitea.listPulls !== "function") throw new Error("gitea 缺少 listPulls，无法扫描合并 PR")
  state.apiWatch ??= { lastPollAt: null, pollCount: 0, candidates: 0, lastResult: "", polling: false }
  if (state.apiWatch.polling) return { ok: true, skipped: "busy" }
  state.apiWatch.polling = true
  try {
    // repos：配了用配的（owner/name 字符串数组），没配 = 全部产品工程。
    const repoNames = (section.repos.length ? section.repos : (cfg.repos ?? []).map((r) => r.repo))
      .map((r) => String(r ?? "").trim()).filter(Boolean)
    const book = new Book(cfg.stateFile)
    // 粗筛候选（可发判官的）与已处理（已拉过 diff 但未命中的）分开：前者封顶 maxPrsPerRound，
    // 超出的留到下一轮；只有真正处理过（拉了 diff）的才打 apiCheckedAt，没轮到的下轮再来。
    const candidates = []
    let processed = 0
    let fresh = 0
    for (const repo of repoNames) {
      if (candidates.length >= section.maxPrsPerRound || processed >= section.maxProcessPerRound) break
      for (let page = 1; page <= section.maxPages; page++) {
        const pulls = await gitea.listPulls(repo, { state: "closed", page })
        if (!Array.isArray(pulls) || !pulls.length) break
        for (const pr of pulls) {
          if (!pr?.merged || pr.number == null) continue
          const key = `${repo}#${pr.number}`
          if (book.prSeen[key]?.apiCheckedAt) continue
          fresh++
          if (processed >= section.maxProcessPerRound || candidates.length >= section.maxPrsPerRound) continue
          let diff = ""
          try {
            diff = await gitea.pullPrDiff(repo, pr.number)
          } catch (e) {
            // 拉 diff 失败不打标：暂时性故障（API 抖/适配器缺方法）下轮重试，永久漏检比多扫一轮更糟。
            processed++
            log?.(`接口巡检拉 diff 失败 ${key}：${e.message}（不打标，下轮重试）`)
            continue
          }
          processed++
          book.markPrSeen(key, { apiCheckedAt: nowIso(), merged: true, repo, number: pr.number, title: pr.title ?? "", url: pr.url ?? "", author: pr.author ?? "", via: "apiwatch" })
          if (!diff || !touchesInterface(diff, section.include)) continue
          candidates.push({
            repo,
            number: pr.number,
            title: pr.title ?? "",
            url: pr.url ?? "",
            author: pr.author ?? "",
            mergedAt: pr.mergedAt ?? "",
            diff: truncate(diff, section.maxDiffChars),
          })
        }
        if (pulls.length < 20) break // 列表页到底（Gitea 默认每页 20 条左右，同 prWatch 口径）
      }
    }
    state.apiWatch.lastPollAt = nowIso()
    state.apiWatch.pollCount++
    state.apiWatch.candidates += candidates.length
    state.apiWatch.lastResult = candidates.length
      ? `本轮候选 ${candidates.length} 条（已交判官）`
      : `本轮无候选（扫到 ${fresh} 条新合并 PR，粗筛未命中）`
    if (candidates.length) {
      log?.(`接口巡检：${candidates.length} 条候选入箱，交判官精判`)
      return {
        ok: true,
        scanned: fresh,
        processed,
        candidates: candidates.length,
        inbox: {
          type: "apibreak.candidates",
          text: candidateText(candidates, section.chatIds),
          json: { chatIds: [...section.chatIds], prs: candidates },
        },
      }
    }
    // 静默轮：粗筛没命中就不产生事件（同 mail 轮询口径），cron 照常推进。
    return { ok: true, scanned: fresh, processed, candidates: 0, inbox: false }
  } finally {
    state.apiWatch.polling = false
  }
}
