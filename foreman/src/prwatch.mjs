// PR 监听：定时扫配置里各仓库的 open PR，把「作者不是自己（233151）」的单通知给最早登记的调用方，
// 只通知不合并（合并由收到通知的会话决定）。去重记在账本 prWatch 键下，重启不重发。
import { nowIso } from "./util.mjs"
import { Book } from "./book.mjs"

// 「第一个调用方」：账本 sessions 里按登记顺序第一个带 convId 的会话（JSON 保持插入序）。
export function earliestCaller(book) {
  for (const [, s] of Object.entries(book?.sessions ?? {})) {
    const t = String(s?.convId ?? "").trim()
    if (t) return t
  }
  return ""
}

// 通知目标：显式写死的 id/标题优先；earliest（默认）/auto 都取最早登记的调用方。
// 账本里一个调用方都没有时返回空串，由调用方（服务层）决定要不要退回环境里的会话 id。
export function prWatchTarget(cfg, book) {
  const raw = String(cfg?.prWatch?.notifyTarget ?? "earliest").trim()
  if (raw && raw !== "earliest" && raw !== "auto") return raw
  return earliestCaller(book)
}

export function prKey(repo, number) {
  return `${repo}#${number}`
}

// 这条 PR 要不要报：作者不在忽略名单里（缺失作者时按「要报」处理，避免漏单）。
export function shouldReport(pr, cfg) {
  if (!pr?.number || !pr?.repo) return false
  const ignore = new Set((cfg?.prWatch?.ignoreAuthors ?? []).map((a) => String(a).trim()).filter(Boolean))
  if (!ignore.size) return true
  const author = String(pr?.author ?? "").trim()
  if (!author) return true
  return !ignore.has(author)
}

// 通知正文：一条消息把所有新 PR 列清楚，带链接与合并命令，方便调用方直接动手。
export function prNotifyText(prs = []) {
  const lines = [`【foreman】发现 ${prs.length} 条待合并 PR（作者不是 233151）`]
  for (const pr of prs) {
    lines.push("")
    lines.push(`· ${pr.repo}#${pr.number} ${pr.title ?? ""}`.trim())
    lines.push(`  作者：${pr.author || "未知"}`)
    if (pr.url) lines.push(`  链接：${pr.url}`)
    lines.push(`  合并：opencli gitea pr-merge ${pr.number} --repo ${pr.repo} --style merge --delete-branch`)
  }
  lines.push("")
  lines.push("只通知不合并：验收后由你决定是否合并。")
  return lines.join("\n")
}

// 跑一轮 PR 扫描：列 open PR → 过滤作者 → 账本去重 → 合并成一条消息通知最早登记的调用方。
// 只有发成功才记账；发送失败下一轮重试。
export async function prWatchOnce({ cfg, gitea, dws, log = () => {}, target: overrideTarget }) {
  const pw = cfg?.prWatch ?? {}
  if (pw.enabled === false) return { ok: true, skipped: "disabled" }

  const book = new Book(cfg.stateFile)
  // 调用方（服务层）可以显式给目标；没给就按配置/账本自己算。
  const target = String(overrideTarget ?? prWatchTarget(cfg, book) ?? "").trim()
  const stateFilter = String(pw.state ?? "open")
  const maxPages = Number(pw.maxPages ?? 3) || 3

  const fresh = []
  let checked = 0
  for (const repoCfg of cfg.repos ?? []) {
    for (let page = 1; page <= maxPages; page++) {
      let list = []
      try {
        list = await gitea.listPulls(repoCfg.repo, { state: stateFilter, page })
      } catch (e) {
        log(`PR 扫描 ${repoCfg.repo} 第 ${page} 页失败：${e.message}`)
        break
      }
      if (!list.length) break
      for (const pr of list) {
        checked++
        const key = prKey(pr.repo || repoCfg.repo, pr.number)
        if (book.prSeen[key]?.notifiedAt) continue
        if (!shouldReport({ ...pr, repo: pr.repo || repoCfg.repo }, cfg)) {
          // 自己的 PR 也记一笔，避免以后误报；不发通知。
          book.markPrSeen(key, { ...pr, skipped: "self" })
          continue
        }
        fresh.push({ ...pr, repo: pr.repo || repoCfg.repo, key })
      }
      if (list.length < 20) break // 列表页到底（Gitea 默认每页 20 条左右）
    }
  }

  if (!fresh.length) return { ok: true, checked, notified: 0, target }
  if (!target) {
    log("PR 扫描：有候选但找不到通知目标（账本里没有调用方会话），这轮不发")
    return { ok: true, checked, notified: 0, target: "", pending: fresh.length }
  }

  await dws.notify(target, prNotifyText(fresh))
  const book2 = new Book(cfg.stateFile)
  for (const pr of fresh) {
    book2.markPrSeen(pr.key, { ...pr, notifiedTo: target })
  }
  log(`PR 扫描：${fresh.length} 条新 PR 已通知 ${target}（${fresh.map((p) => `${p.repo}#${p.number}`).join("、")}）`)
  return { ok: true, checked, notified: fresh.length, target, prs: fresh.map((p) => p.key), at: nowIso() }
}
