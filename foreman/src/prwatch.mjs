// PR 监听：定时扫配置里各仓库的 open PR，作者不是自己（pickup.me / prWatch.ignoreAuthors）的单**通知编排 agent 去合并**
// （监听只看得到 PR，看不到关联工单，合并必须由能核对工单的编排做）。去重记在账本 prWatch 键下。
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

// 合并失败要说明为什么：先用 pr-merge 的报错，再去 pr-view 捞 mergeNote/state 交叉印证。
export async function mergeFailureReason({ gitea, repo, pr, error } = {}) {
  const err = String(error?.message ?? error ?? "").trim()
  let note = ""
  try {
    const v = await gitea.viewPr(repo, pr)
    const obj = Array.isArray(v) ? v[0] : v
    note = [obj?.mergeNote, obj?.state].map((x) => String(x ?? "").trim()).filter(Boolean).join("；")
  } catch {}
  const reason = note && err && !err.includes(note) ? `${err}（PR 状态：${note}）` : (err || note || "未知原因")
  return reason.slice(0, 300)
}

// 通知正文：一条消息列清楚每条待合并 PR，并给出「核对工单后合并」的入口。
export function prNotifyText(prs = []) {
  const lines = [`【foreman】别人家的 PR ${prs.length} 条，等你核对工单后合并`]
  for (const pr of prs) {
    lines.push("")
    lines.push(`· ${pr.repo}#${pr.number} ${pr.title ?? ""}`.trim())
    lines.push(`  作者：${pr.author || "未知"}`)
    if (pr.url) lines.push(`  链接：${pr.url}`)
    lines.push(`  合并：foreman pr merge ${pr.number} --repo ${pr.repo}`)
  }
  lines.push("")
  lines.push("先核对 PR 关联的工单与改动，再执行上面的合并；合不了 foreman 会回理由。")
  return lines.join("\n")
}

// 有冲突的 PR 不合也不报：pr-view 的 mergeNote / mergeable 判定，冲突的单记 skipped=conflict，
// 下轮还会再查（冲突解掉后自动恢复正常通知）。
export function isConflicting(view) {
  const v = Array.isArray(view) ? view[0] : view
  if (!v) return false
  const note = String(v.mergeNote ?? v.merge_note ?? "")
  if (/冲突|conflict/i.test(note)) return true
  if (v.mergeable === false || v.mergeable === "false") return true
  return false
}

// 跑一轮 PR 扫描：列 open PR → 过滤作者 → 账本去重 → 查冲突（冲突的过滤掉）→ 交给编排 agent 去合并。
// deliver 给了就每次新建一条会话投递（首句带固定提示词），否则塞回 target 那条已有会话。
// 只有发成功才记账；发送失败下一轮重试。
export async function prWatchOnce({ cfg, gitea, dws, log = () => {}, target: overrideTarget, deliver = null }) {
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
        const seen = book.prSeen[key]
        if (seen?.notifiedAt) continue
        if (!shouldReport({ ...pr, repo: pr.repo || repoCfg.repo }, cfg)) {
          // 自己的 PR 也记一笔，避免以后误报；不发通知。
          book.markPrSeen(key, { ...pr, skipped: "self" })
          continue
        }
        fresh.push({ ...pr, repo: pr.repo || repoCfg.repo, key, seen })
      }
      if (list.length < 20) break // 列表页到底（Gitea 默认每页 20 条左右）
    }
  }

  // 默认过滤掉有冲突的（prWatch.filterConflicts !== false）：这类单合不了，报了也没用；
  // 等冲突解掉下一轮会再查。
  let conflicting = 0
  const filterConflicts = pw.filterConflicts !== false
  if (filterConflicts && fresh.length) {
    const keep = []
    for (const pr of fresh) {
      let view = null
      try { view = await gitea.viewPr(pr.repo, pr.number) } catch {}
      if (isConflicting(view)) {
        conflicting++
        new Book(cfg.stateFile).markPrSeen(pr.key, { ...pr, skipped: "conflict" })
        log(`PR 扫描：跳过有冲突的 ${pr.repo}#${pr.number}`)
        continue
      }
      keep.push(pr)
    }
    fresh.length = 0
    fresh.push(...keep)
  }

  if (!fresh.length) return { ok: true, checked, notified: 0, conflicting, target }
  const useNew = typeof deliver === "function"
  if (!useNew && !target) {
    log("PR 扫描：有候选但找不到通知目标（账本里没有调用方会话），这轮不发，等有了再报")
    return { ok: true, checked, notified: 0, target: "", pending: fresh.length }
  }

  let sentTo = target
  let convId = ""
  try {
    if (useNew) {
      // 一轮可能跨多个仓库：全部来自同一个仓库才按产品取提示词，否则回落全局 deliver。
      const repo = fresh.every((pr) => pr.repo === fresh[0].repo) ? fresh[0].repo : ""
      const out = await deliver({ text: prNotifyText(fresh), kind: "PR待合并", repo, lane: "merge" })
      sentTo = out?.session || out?.convId || ""
      convId = String(out?.convId ?? "")
    } else {
      await dws.notify(target, prNotifyText(fresh))
    }
  } catch (e) {
    log(`PR 扫描：通知 ${sentTo || "新会话"} 失败，下轮补发：${e.message}`)
    return { ok: true, checked, notified: 0, conflicting, target, failedNotify: true, pending: fresh.length }
  }
  const book2 = new Book(cfg.stateFile)
  for (const pr of fresh) book2.markPrSeen(pr.key, { ...pr, notifiedTo: sentTo, via: useNew ? "new-session" : "existing" })
  // 新建的投递会话登记进 notices：它报过的 PR 全合完之后由服务自动归档，
  // 不然这些「PR待合并」会话会一条条留在侧边栏里（既没人读、也没人收）。
  if (useNew && sentTo) {
    book2.markNotice(sentTo, { name: sentTo, convId, kind: "PR待合并", prs: fresh.map((p) => p.key) })
  }
  log(`PR 扫描：${fresh.length} 条新 PR 已交给 ${sentTo || "新会话"} 合并（${fresh.map((p) => `${p.repo}#${p.number}`).join("、")}）`)
  return { ok: true, checked, notified: fresh.length, conflicting, target, via: useNew ? "new-session" : "existing", prs: fresh.map((p) => p.key), at: nowIso() }
}
