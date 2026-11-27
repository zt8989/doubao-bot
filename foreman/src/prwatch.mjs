// PR 监听：代码定时扫 open PR 及其更新。他人候选只写 pr.merge Inbox 事件（不建会话），
// 由 Worker 派合并助手；本人 UI 候选与新增/编辑评论才交 router agent（pr ui-assign / pr.updates）。
import crypto from "node:crypto"
import { nowIso } from "./util.mjs"
import { Book } from "./book.mjs"
import { uiFilesChanged, uiPatterns } from "./mailflow.mjs"

// 「第一个调用方」：账本 sessions 里按登记顺序第一个带 convId 的会话（JSON 保持插入序）。
export function earliestCaller(book) {
  for (const [, s] of Object.entries(book?.sessions ?? {})) {
    const t = String(s?.convId ?? "").trim()
    if (t) return t
  }
  return ""
}

// 通知目标：显式写死的 id/标题优先；earliest（默认）/auto 都取最早登记的调用方。
// 会话中心（sessionFlow.enabled）下固定取唯一编排会话——所有更新都归这一条。
// 账本里一个调用方都没有时返回空串，由调用方（服务层）决定要不要退回环境里的会话 id。
export function prWatchTarget(cfg, book) {
  const raw = String(cfg?.prWatch?.notifyTarget ?? "earliest").trim()
  if (raw && raw !== "earliest" && raw !== "auto") return raw
  if (cfg?.sessionFlow?.enabled === true) {
    const orch = String(book?.data?.orchestrator?.convId ?? "").trim()
    if (orch) return orch
  }
  return earliestCaller(book)
}

export function prKey(repo, number) {
  return `${repo}#${number}`
}

// 账本里已经登记过的自家 PR：issues[<工单仓库>#<工单号>] 的 pr 与 prs[]（一工程一工作区时跨工程各一条）。
// Gitea 列表返回的 author 常为空，不能只靠作者判归属；账本记过就一定是自己的单。
export function ownedPrKeys(book) {
  const keys = new Set()
  for (const [issueKey, rec] of Object.entries(book?.issues ?? {})) {
    const repo = String(issueKey).split("#")[0]
    const pr = Number(rec?.pr ?? 0)
    if (repo && pr) keys.add(prKey(repo, pr))
    for (const w of Array.isArray(rec?.prs) ? rec.prs : []) {
      const r = String(w?.repo ?? "").trim()
      const n = Number(w?.pr ?? 0)
      if (r && n) keys.add(prKey(r, n))
    }
  }
  return keys
}

// 自有工单里已确认涉及 UI 的 PR；用于列表作者为空或 PR 文件接口暂时不可用时兜底。
export function ownedUiPrKeys(book) {
  const keys = new Set()
  for (const [issueKey, rec] of Object.entries(book?.issues ?? {})) {
    if (rec?.ui !== true) continue
    const repo = String(issueKey).split("#")[0]
    const pr = Number(rec?.pr ?? 0)
    if (repo && pr) keys.add(prKey(repo, pr))
    for (const w of Array.isArray(rec?.prs) ? rec.prs : []) {
      const r = String(w?.repo ?? "").trim()
      const n = Number(w?.pr ?? 0)
      if (r && n) keys.add(prKey(r, n))
    }
  }
  return keys
}

export function uiReviewers(cfg) {
  const raw = Array.isArray(cfg?.prWatch?.uiReviewers) ? cfg.prWatch.uiReviewers : []
  return raw.map((x) => typeof x === "string"
    ? { name: x.trim(), username: x.trim() }
    : { name: String(x?.name ?? x?.username ?? "").trim(), username: String(x?.username ?? "").trim() })
    .filter((x) => x.name || x.username)
}

export function uiReviewersReady(cfg) {
  const list = uiReviewers(cfg)
  return list.length > 0 && list.every((x) => x.username)
}

export function isOwnPr(pr, cfg, book) {
  const key = prKey(pr?.repo, pr?.number)
  const seen = book?.prSeen?.[key]
  if (String(seen?.skipped ?? "") === "self" || ownedPrKeys(book).has(key)) return true
  const author = String(pr?.author ?? "").trim()
  const ignore = new Set((cfg?.prWatch?.ignoreAuthors ?? []).map((x) => String(x).trim()).filter(Boolean))
  return Boolean(author && ignore.has(author))
}

export function isUiPrView(view, cfg, { key = "", book = null, seen = null } = {}) {
  if (seen?.ui === true || (key && ownedUiPrKeys(book).has(key))) return true
  const v = Array.isArray(view) ? view[0] : view
  const files = (Array.isArray(v?.files) ? v.files : []).map((f) => String(f?.name ?? f?.filename ?? "").trim()).filter(Boolean)
  return uiFilesChanged(files, uiPatterns(cfg)).length > 0
}

// 这条 PR 要不要报：必须能确认作者不在忽略名单里；作者缺失不能证明是他人 PR，先跳过。
export function shouldReport(pr, cfg) {
  if (!pr?.number || !pr?.repo) return false
  const ignore = new Set((cfg?.prWatch?.ignoreAuthors ?? []).map((a) => String(a).trim()).filter(Boolean))
  const author = String(pr?.author ?? "").trim()
  if (!author) return false
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

// 通知正文：列清楚每条待合并 PR 与合并命令；合并助手核对后直接执行，不交 RESULT。
export function prNotifyText(prs = []) {
  const lines = [`【foreman】别人家的 PR ${prs.length} 条，核对后可合的请直接合并`]
  for (const pr of prs) {
    lines.push("")
    lines.push(`· ${pr.repo}#${pr.number} ${pr.title ?? ""}`.trim())
    lines.push(`  作者：${pr.author || "未知"}`)
    if (pr.url) lines.push(`  链接：${pr.url}`)
    lines.push(`  合并：foreman pr merge ${pr.number} --repo ${pr.repo}`)
  }
  lines.push("")
  lines.push("先核对 PR 关联的工单与改动；可合就直接执行上面的合并命令，不可合或需要拍板就普通文字说明原因，不要输出 RESULT。若工单或 PR 涉及 UI（页面、样式、组件、交互等），必须先请用户人工验收，只有用户明确回复「合并」后才能执行合并；未收到前保持 PR 打开。")
  return lines.join("\n")
}

// 扫描器交给router agent的候选：只给分配命令，不让它主动扫 PR，也不让它直接合并。
export function prInspectorText(prs = [], cfg = {}, uiPrs = []) {
  const me = String(cfg?.pickup?.me ?? cfg?.prWatch?.ignoreAuthors?.[0] ?? "").trim() || "本人"
  const lines = []
  if (prs.length) {
    lines.push(
      "【Foreman · router agent · 他人 PR 待分配】",
      "代码已完成 open PR 扫描、作者过滤和冲突检查。你不需要主动读取 PR 列表；请核对下面的候选，决定是否分配合并助手。",
      `本人账号 ${me} 创建的 PR 不分配、不合并；作者不明的 PR 也不分配。你只通过 pr assign 分配，不要直接执行 foreman pr merge。`,
    )
  }
  for (const pr of prs) {
    lines.push("")
    lines.push(`· ${pr.repo}#${pr.number} ${pr.title ?? ""}`.trim())
    lines.push(`  作者：${pr.author}`)
    if (pr.url) lines.push(`  链接：${pr.url}`)
    lines.push(`  分配：foreman pr assign ${pr.number} --repo ${pr.repo}`)
  }
  if (uiPrs.length) {
    if (lines.length) lines.push("")
    lines.push(
      "【Foreman · router agent · 本人 UI PR 待验收指派】",
      "代码已确认下列 PR 是本人创建且涉及 UI。请逐条执行 pr ui-assign，由 Foreman 在周晓亮、张振豪之间轮询指派一位验收人；不要自行指定人、不要分配合并助手、不要合并。",
    )
    for (const pr of uiPrs) {
      lines.push("")
      lines.push(`· ${pr.repo}#${pr.number} ${pr.title ?? ""}`.trim())
      if (pr.url) lines.push(`  链接：${pr.url}`)
      lines.push(`  验收指派：foreman pr ui-assign ${pr.number} --repo ${pr.repo}`)
    }
  }
  return lines.join("\n")
}

// 代码扫描 PR 评论：首次只建基线；之后新增或编辑评论才交 router agent，单纯提交变化不通知。
// 这里只生成事实与变化类型，不判断是否应该合并。
export function prUpdateSnapshot(pr = {}, view = {}) {
  const v = Array.isArray(view) ? view[0] : view
  const comments = (Array.isArray(v?.comments) ? v.comments : []).map((comment) => ({
    id: String(comment?.id ?? ""),
    author: String(comment?.author ?? comment?.user?.login ?? ""),
    body: String(comment?.body ?? comment?.bodyMd ?? ""),
    authoredAt: String(comment?.authoredAt ?? comment?.created_at ?? ""),
  }))
  const latest = comments.at(-1)
  const snapshot = {
    headSha: String(v?.headSha ?? v?.head?.sha ?? pr?.headSha ?? ""),
    updatedAt: String(v?.updatedAt ?? v?.updated_at ?? pr?.updatedAt ?? ""),
    latestCommentId: String(latest?.id ?? ""),
    comments: comments.slice(-3),
  }
  snapshot.fingerprint = crypto.createHash("sha256").update(JSON.stringify(comments)).digest("hex")
  return snapshot
}

function prUpdateBookFields(snapshot) {
  return {
    updateFingerprint: snapshot.fingerprint,
    updateHeadSha: snapshot.headSha,
    updateLatestCommentId: snapshot.latestCommentId,
    updatePrUpdatedAt: snapshot.updatedAt,
  }
}

export function prUpdateChanges(seen = {}, snapshot) {
  if (String(seen?.updateLatestCommentId ?? "") !== snapshot.latestCommentId) return ["新评论"]
  return ["评论更新"]
}

export function prUpdateInspectorText(prs = []) {
  if (!prs.length) return ""
  const lines = [
    "【Foreman · router agent · PR 更新】",
    "代码已检测到下列 open PR 相对上次扫描发生变化；扫描过程没有启动 Agent，也没有执行合并。是否合并、是否关闭关联 issue 由你决定。",
  ]
  for (const pr of prs) {
    lines.push("")
    lines.push(`· ${pr.repo}#${pr.number} ${pr.title ?? ""}`.trim())
    if (pr.url) lines.push(`  链接：${pr.url}`)
    lines.push(`  变化：${pr.changes.join("、")}`)
    if (pr.updateSnapshot.headSha) lines.push(`  head：${pr.updateSnapshot.headSha}`)
    for (const comment of pr.updateSnapshot.comments) {
      lines.push(`  评论 #${comment.id || "未知"} ${comment.author || "未知"}：${comment.body}`)
    }
    lines.push(`  若你决定合并：foreman pr merge ${pr.number} --repo ${pr.repo}`)
  }
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

// 跑一轮 PR 扫描：列 open PR → 过滤作者 → 账本去重 → 查冲突（冲突的过滤掉）→ 交给合并助手核对。
// push 给了就 steer 进唯一编排会话（会话中心，默认）；deliver 给了才每次新建一条会话；
// 都没有就塞回 target 那条已有会话。只有发成功才记账；发送失败下一轮重试。
export async function prWatchOnce({ cfg, gitea, session, log = () => {}, target: overrideTarget, inspect = null, deliver = null, push = null, enqueue = null }) {
  const pw = cfg?.prWatch ?? {}
  if (pw.enabled === false) return { ok: true, skipped: "disabled" }

  const book = new Book(cfg.stateFile)
  // 调用方（服务层）可以显式给目标；没给就按配置/账本自己算。
  const target = String(overrideTarget ?? prWatchTarget(cfg, book) ?? "").trim()
  const stateFilter = String(pw.state ?? "open")
  const maxPages = Number(pw.maxPages ?? 3) || 3

  const fresh = []
  const uiFresh = []
  const updatedFresh = []
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
        const repo = pr.repo || repoCfg.repo
        const key = prKey(repo, pr.number)
        const seen = book.prSeen[key]
        const item = { ...pr, repo, key, seen }
        // 所有 open PR 都由代码检测更新，包括本人 PR；首次仅建基线，变化指纹在投递成功后才推进。
        if (pw.routeUpdates !== false && typeof gitea.viewPr === "function") {
          try {
            const view = await gitea.viewPr(repo, pr.number)
            const snapshot = prUpdateSnapshot(item, view)
            if (!seen?.updateFingerprint) {
              book.markPrSeen(key, { ...item, ...prUpdateBookFields(snapshot) })
            } else if (seen.updateFingerprint !== snapshot.fingerprint) {
              updatedFresh.push({ ...item, updateSnapshot: snapshot, changes: prUpdateChanges(seen, snapshot) })
            }
          } catch (e) {
            log(`PR 更新检查 ${key} 失败，下轮重试：${e.message}`)
          }
        }
        if (isOwnPr(item, cfg, book)) {
          // 本人 PR 不走合并助手；只有确认涉及 UI 时才交router agent做验收指派。
          if (seen?.reviewNotifiedAt || seen?.reviewAssignedAt) continue
          if (!uiReviewersReady(cfg)) {
            if (seen?.skipped === "self" || ownedPrKeys(book).has(key)) continue
            book.markPrSeen(key, { ...item, skipped: "self" })
            continue
          }
          let view = null
          const knownUi = seen?.ui === true || ownedUiPrKeys(book).has(key)
          if (!knownUi) {
            try { view = await gitea.viewPr(repo, pr.number, { files: true }) } catch (e) {
              log(`本人 PR UI 检查 ${key} 失败，下轮重试：${e.message}`)
              continue
            }
          }
          if (!knownUi && !isUiPrView(view, cfg, { key, book, seen })) {
            book.markPrSeen(key, { ...item, skipped: "self", ui: false })
            continue
          }
          uiFresh.push({ ...item, ui: true })
          continue
        }
        if (seen?.notifiedAt) continue
        if (!shouldReport(item, cfg)) {
          const author = String(pr?.author ?? "").trim()
          // 作者不明只暂停本轮，后续作者补全后仍可重新检查。
          book.markPrSeen(key, { ...item, skipped: author ? "self" : "unknown-author" })
          continue
        }
        fresh.push(item)
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

  // 三条通道各走各的：他人 PR 只写 pr.merge Inbox 事件（扫描不建会话，Worker 才派合并助手）；
  // 本人 UI 候选与 PR 评论更新仍交 router agent 决策（要不要指派验收、评论变化怎么处理）。
  const useInbox = fresh.length > 0 && typeof enqueue === "function"
  const useMerge = !useInbox && fresh.length > 0 && typeof deliver === "function"
  const useInspect = typeof inspect === "function"
  const usePush = !useInbox && !useMerge && typeof push === "function"
  const uiToSend = useInspect ? uiFresh : []
  const updatedToSend = useInspect ? updatedFresh : []
  // 没有合并通道时，他人候选仍退回路由中转（测试与旧调用方保持原行为）。
  const freshByRouter = fresh.length > 0 && !useInbox && !useMerge && !usePush && useInspect

  if (!fresh.length && !uiToSend.length && !updatedToSend.length) {
    return { ok: true, checked, notified: 0, uiNotified: 0, updatedNotified: 0, conflicting, target, pending: uiFresh.length + updatedFresh.length }
  }
  if (!useInbox && !useMerge && !useInspect && !usePush && !target) {
    log("PR 扫描：有候选但找不到通知目标（账本里没有调用方会话），这轮不发，等有了再报")
    return { ok: true, checked, notified: 0, updatedNotified: 0, target: "", pending: fresh.length + updatedFresh.length }
  }

  const prJson = (list) => list.map((pr) => ({
    key: pr.key, repo: pr.repo, number: Number(pr.number), title: String(pr.title ?? ""),
    url: String(pr.url ?? ""), author: String(pr.author ?? ""), ui: pr.ui === true,
  }))

  // 1) 他人 PR：只写 Inbox，不在扫描里建会话。会话名、assignedTo、notifiedAt 都由 Worker 投递成功后回写；
  // 这里提前写会让「事件还在重试」的 PR 被下一轮扫描当成已通知而漏掉。
  let mergeTo = ""
  let mergeConvId = ""
  let mergeFailed = false
  if (fresh.length) {
    try {
      if (useInbox) {
        const text = prNotifyText(fresh)
        const repo = fresh.every((pr) => pr.repo === fresh[0].repo) ? fresh[0].repo : ""
        const keys = fresh.map((pr) => pr.key).sort()
        const out = await enqueue({
          kind: "pr.merge",
          text,
          payload: { type: "pr.merge", agent: "merge", repo, prs: prJson(fresh), text },
          dedupeKey: `pr:merge:${crypto.createHash("sha256").update(keys.join(",")).digest("hex")}`,
        })
        if (out?.ok === false) throw new Error(out.error || "pr.merge 入箱失败")
        mergeTo = "inbox"
      } else if (useMerge) {
        // 一轮跨多个仓库时取不到单一产品提示词，回落全局 deliver。
        const repo = fresh.every((pr) => pr.repo === fresh[0].repo) ? fresh[0].repo : ""
        const out = await deliver({ text: prNotifyText(fresh), kind: "PR待合并", repo, lane: "merge" })
        mergeTo = String(out?.session ?? "").trim()
        mergeConvId = String(out?.convId ?? "").trim()
        if (!mergeTo) throw new Error("合并会话创建成功返回但没有会话名")
      } else if (usePush) {
        mergeTo = (await push(prNotifyText(fresh))) || target
      } else if (!freshByRouter) {
        mergeTo = target
        await session.notify(target, prNotifyText(fresh))
      }
    } catch (e) {
      log(`PR 扫描：他人 PR 投递失败，下轮补发：${e.message}`)
      mergeFailed = true
    }
  }

  // 2) 本人 UI 候选与评论更新：只交 router agent；没有 inspect 时这轮不发。
  const inspectCandidates = [...(freshByRouter ? fresh : []), ...uiToSend]
  let inspectTo = ""
  let inspectFailed = false
  if (useInspect && (inspectCandidates.length || updatedToSend.length)) {
    try {
      const out = await inspect({
        type: inspectCandidates.length ? "pr.candidates" : "pr.updates",
        text: [prInspectorText(freshByRouter ? fresh : [], cfg, uiToSend), prUpdateInspectorText(updatedToSend)].filter(Boolean).join("\n\n"),
        json: {
          checked,
          conflicting,
          prs: prJson(inspectCandidates),
          updates: updatedToSend.map((pr) => ({
            key: pr.key, repo: pr.repo, number: Number(pr.number), title: String(pr.title ?? ""),
            url: String(pr.url ?? ""), author: String(pr.author ?? ""),
            headSha: pr.updateSnapshot.headSha, updatedAt: pr.updateSnapshot.updatedAt,
            changes: pr.changes, comments: pr.updateSnapshot.comments,
          })),
        },
      })
      if (out?.ok === false || out?.skipped) throw new Error(out.error || `router agent接收 PR 候选失败：${out.skipped}`)
      inspectTo = String(out?.convId ?? out?.session ?? "").trim() || "router agent"
    } catch (e) {
      log(`PR 扫描：交给 router agent 失败，下轮补发：${e.message}`)
      inspectFailed = true
    }
  }

  // 只记真发出去的那部分；失败的下轮补发，不推进去重。
  // 走 Inbox 的他人 PR 这里不记账：Worker 投递成功后才写 notifiedTo / assignedTo。
  const book2 = new Book(cfg.stateFile)
  if (fresh.length && mergeTo && !mergeFailed && !useInbox) {
    for (const pr of fresh) {
      book2.markPrSeen(pr.key, {
        ...pr, notifiedTo: mergeTo, via: useMerge ? "merge-assistant" : "orchestrator",
        ...(useMerge ? { assignedTo: mergeTo, assignedConvId: mergeConvId, assignedAt: nowIso() } : {}),
      })
    }
  }
  for (const pr of uiToSend) {
    if (inspectFailed) break
    book2.markPrSeen(pr.key, { ...pr, skipped: "self", ui: true, reviewNotifiedTo: inspectTo, via: "inspector-ui" })
  }
  for (const pr of updatedToSend) {
    if (inspectFailed) break
    book2.markPrSeen(pr.key, { ...pr, ...prUpdateBookFields(pr.updateSnapshot), updateRoutedTo: inspectTo, via: "inspector-update" })
  }
  // 新建的合并会话登记进 notices：它报过的 PR 全合完之后由服务自动归档，
  // 不然这些「PR待合并」会话会一条条留在侧边栏里（既没人读、也没人收）。
  if (useMerge && mergeTo && !mergeFailed) {
    book2.markNotice(mergeTo, { name: mergeTo, convId: mergeConvId, kind: "PR待合并", prs: fresh.map((p) => p.key) })
  }
  if (mergeFailed || inspectFailed) log(`PR 扫描：部分投递失败，下轮补发（他人 PR ${mergeFailed ? "失败" : "正常"}、路由 ${inspectFailed ? "失败" : "正常"}）`)
  else if (fresh.length && useInbox) log(`PR 扫描：${fresh.length} 条新 PR 已写入 pr.merge Inbox，待 Worker 派合并助手（${fresh.map((p) => `${p.repo}#${p.number}`).join("、")}）`)
  else if (fresh.length && useMerge) log(`PR 扫描：${fresh.length} 条新 PR 已直投合并会话 ${mergeTo}（${fresh.map((p) => `${p.repo}#${p.number}`).join("、")}）`)

  const delivered = (mergeFailed ? 0 : fresh.length) + (inspectFailed ? 0 : uiToSend.length + updatedToSend.length)
  return {
    ok: true, checked, notified: delivered,
    uiNotified: inspectFailed ? 0 : uiToSend.length,
    updatedNotified: inspectFailed ? 0 : updatedToSend.length,
    conflicting,
    target: mergeTo || inspectTo || target,
    via: useInbox ? "inbox" : useMerge ? "merge-direct" : usePush ? "steer-orchestrator" : freshByRouter ? "inspector" : "existing",
    failedNotify: mergeFailed || inspectFailed,
    prs: [...(mergeFailed ? [] : fresh), ...(inspectFailed ? [] : uiToSend)].map((p) => p.key),
    updates: inspectFailed ? [] : updatedToSend.map((p) => p.key),
    at: nowIso(),
  }
}
