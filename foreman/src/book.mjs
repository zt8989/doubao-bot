// 状态账本：~/.foreman/state.json。只记编排需要的东西（工单到哪一步、哪个会话、哪条分支）。
// 新增顶层键 watch（显式监听）与 notified（已通知指纹），不动 issues/sessions 老记录。
import fs from "node:fs"
import path from "node:path"
import { nowIso } from "./util.mjs"

export class Book {
  constructor(file) {
    this.file = file
    this.data = load(file)
  }

  get issues() {
    return this.data.issues ?? (this.data.issues = {})
  }

  get sessions() {
    return this.data.sessions ?? (this.data.sessions = {})
  }

  // 显式监听列表：[{ target, name, issueKey, repo, number, notifyTo, addedAt }]
  get watch() {
    return this.data.watch ?? (this.data.watch = [])
  }

  // 已通知去重表：{ "<target>": { fingerprint, at, phase, chars } }
  get notified() {
    return this.data.notified ?? (this.data.notified = {})
  }

  // PR 监听账本：{ "<repo>#<number>": { author, title, url, notifiedAt, ... } }
  get prSeen() {
    return this.data.prWatch ?? (this.data.prWatch = {})
  }

  // 记一条 PR 见过/已通知；notifiedAt 只有真发出去时才盖。
  // 先 reload：PR 扫描与合并、CLI 会并发写同一个 state.json，拿着旧快照整文件覆盖会把
  // 刚写进去的 notifiedTo 抹掉（#238 就是这么丢的，丢了就找不到该归档的通知会话）。
  markPrSeen(key, pr = {}) {
    this.reload()
    const prev = this.prSeen[key] ?? {}
    this.prSeen[key] = {
      ...prev,
      repo: pr.repo ?? prev.repo ?? "",
      number: pr.number ?? prev.number ?? null,
      title: pr.title ?? prev.title ?? "",
      url: pr.url ?? prev.url ?? "",
      author: pr.author ?? prev.author ?? "",
      skipped: pr.skipped ?? prev.skipped ?? "",
      seenAt: prev.seenAt ?? nowIso(),
      notifiedTo: pr.notifiedTo ?? prev.notifiedTo ?? "",
      notifiedAt: pr.notifiedTo ? nowIso() : prev.notifiedAt ?? "",
      // 投递通道：router（候选交 router agent）或 merge-assistant（已分配合并助手）等。
      via: pr.via ?? prev.via ?? "",
      ui: pr.ui ?? prev.ui ?? false,
      reviewNotifiedTo: pr.reviewNotifiedTo ?? prev.reviewNotifiedTo ?? "",
      reviewNotifiedAt: pr.reviewNotifiedTo ? nowIso() : prev.reviewNotifiedAt ?? "",
      reviewer: pr.reviewer ?? prev.reviewer ?? "",
      reviewerName: pr.reviewerName ?? prev.reviewerName ?? "",
      reviewAssignedAt: pr.reviewAssignedAt ?? prev.reviewAssignedAt ?? "",
      assignedTo: pr.assignedTo ?? prev.assignedTo ?? "",
      assignedConvId: pr.assignedConvId ?? prev.assignedConvId ?? "",
      assignedAt: pr.assignedAt ?? prev.assignedAt ?? "",
      merged: pr.merged ?? prev.merged ?? false,
      mergeError: pr.mergeError ?? prev.mergeError ?? "",
    }
    this.save()
    return this.prSeen[key]
  }

  // 本人 UI PR 验收指派游标；只有 Gitea 指派成功才推进。
  get prReviewRr() {
    return Math.max(0, Number(this.data.prReviewRr ?? 0) || 0)
  }

  setPrReviewRr(next) {
    this.reload()
    this.data.prReviewRr = Math.max(0, Number(next ?? 0) || 0)
    this.save()
    return this.data.prReviewRr
  }

  // 续接提醒去重：{ lastKey, at }，同一个 (会话#指纹) 只提醒一次。
  get planner() {
    return this.data.planner ?? (this.data.planner = {})
  }

  markPlanner(key, extra = {}) {
    this.reload()
    this.planner.lastKey = String(key)
    this.planner.at = nowIso()
    this.planner.kind = extra.kind ?? ""
    this.planner.target = extra.target ?? ""
    this.save()
    return this.planner
  }

  // 已下发过“去合并”指令的 PR：{ "<repo>#<number>": { at, target, pr } }
  get mergeAsk() {
    return this.data.mergeAsk ?? (this.data.mergeAsk = {})
  }

  markMergeAsked(key, info = {}) {
    this.reload()
    const prev = this.mergeAsk[key] ?? {}
    this.mergeAsk[key] = {
      ...prev,
      at: nowIso(),
      target: info.target ?? prev.target ?? "",
      pr: info.pr ?? prev.pr ?? null,
      url: info.url ?? prev.url ?? "",
      status: info.status ?? prev.status ?? "",
      error: info.error ?? prev.error ?? "",
    }
    this.save()
    return this.mergeAsk[key]
  }

  // 唯一编排会话：{ convId, name, at }。全程只有这一条，工作会话都绑在它身上。
  // 不是数组、不按产品分——需要第二条的时候是设计错了，不是配置少了。
  get orchestrator() {
    return this.data.orchestrator ?? (this.data.orchestrator = { convId: "", name: "", at: "" })
  }

  setOrchestrator(info = {}) {
    this.reload()
    const prev = this.data.orchestrator ?? {}
    this.data.orchestrator = {
      convId: String(info.convId ?? prev.convId ?? ""),
      name: String(info.name ?? prev.name ?? ""),
      at: nowIso(),
    }
    this.save()
    return this.data.orchestrator
  }

  // steer 留痕：{ "<编排会话id>": [{ at, kind, chars }] }，只留最近 50 条，够排查不必留全量。
  get steers() {
    return this.data.steers ?? (this.data.steers = {})
  }

  markSteer(target, info = {}) {
    this.reload()
    const k = String(target ?? "")
    const list = Array.isArray(this.steers[k]) ? this.steers[k] : []
    list.push({ at: nowIso(), kind: String(info.kind ?? ""), chars: Number(info.chars ?? 0) || 0 })
    this.steers[k] = list.slice(-50)
    this.save()
    return this.steers[k]
  }

  issue(key) {
    return this.issues[key] ?? null
  }

  setIssue(key, patch) {
    const prev = this.issues[key] ?? {}
    this.issues[key] = { ...prev, ...patch, updatedAt: nowIso() }
    this.save()
    return this.issues[key]
  }

  // 合并队列：{ "<repo>#<pr>": { repo, pr, issue, url, style, deleteBranch, status, at } }
  // poll 只入队，合并通道一条一条取；落盘是为了服务重启后队列还在。
  get mergeQueue() {
    return this.data.mergeQueue ?? (this.data.mergeQueue = {})
  }

  // 验收邮件账本：requests 按 "<repo>#<pr>" 记一次验收（主题带 [FM-…] 筛选 ID），
  // seen 按 message_id 去重（同一封回复只处理一次），rr 是轮转发信的下标。
  get mail() {
    const m = this.data.mail ?? (this.data.mail = {})
    m.requests = m.requests ?? {}
    m.seen = m.seen ?? {}
    m.rr = Number(m.rr ?? 0) || 0
    return m
  }

  markMailRequest(key, patch = {}) {
    this.reload()
    const k = String(key)
    const prev = this.mail.requests[k] ?? {}
    this.mail.requests[k] = { ...prev, ...patch, key: k, updatedAt: nowIso() }
    this.save()
    return this.mail.requests[k]
  }

  markMailSeen(messageId, patch = {}) {
    this.reload()
    const id = String(messageId ?? "").trim()
    if (!id) return null
    this.mail.seen[id] = { ...(this.mail.seen[id] ?? {}), ...patch, at: patch.at ?? nowIso() }
    // 只留最近 500 封：去重表不该无限长，回信本来也只关心最近一段时间。
    const ids = Object.keys(this.mail.seen)
    if (ids.length > 500) {
      for (const old of ids.slice(0, ids.length - 500)) delete this.mail.seen[old]
    }
    this.save()
    return this.mail.seen[id]
  }

  markMailPoll(info = {}) {
    this.reload()
    this.mail.lastPollAt = String(info.at ?? nowIso())
    this.mail.pollCount = Number(this.mail.pollCount ?? 0) + 1
    this.mail.lastChecked = Number(info.checked ?? 0) || 0
    this.save()
    return this.mail
  }

  setMailRr(next) {
    this.reload()
    this.mail.rr = Math.max(0, Number(next ?? 0) || 0)
    this.save()
    return this.mail.rr
  }

  // 合并批准账本：{ "<repo>#<pr>": { by, via: mail|cli|user, tag, note, at } }
  // 邮件验收通过、或调用方带 --approved-by 时落在这里，合并闸门只认这本账。
  get approvals() {
    return this.data.approvals ?? (this.data.approvals = {})
  }

  markApproval(key, info = {}) {
    this.reload()
    const k = String(key)
    const prev = this.approvals[k] ?? {}
    this.approvals[k] = {
      ...prev,
      by: String(info.by ?? prev.by ?? ""),
      via: String(info.via ?? prev.via ?? ""),
      tag: String(info.tag ?? prev.tag ?? ""),
      note: String(info.note ?? prev.note ?? ""),
      at: nowIso(),
    }
    this.save()
    return this.approvals[k]
  }

  approval(key) {
    return this.approvals[String(key ?? "")] ?? null
  }

  enqueueMerge(key, entry = {}) {
    this.reload()
    const k = String(key)
    const prev = this.mergeQueue[k]
    this.mergeQueue[k] = {
      ...prev,
      ...entry,
      key: k,
      status: entry.status ?? prev?.status ?? "queued",
      at: prev?.at ?? nowIso(),
      updatedAt: nowIso(),
    }
    this.save()
    return this.mergeQueue[k]
  }

  mergeTask(key) {
    return this.mergeQueue[String(key)] ?? null
  }

  markMergeTask(key, patch = {}) {
    const prev = this.mergeTask(key)
    if (!prev) return null
    return this.enqueueMerge(key, patch)
  }

  dropMerge(key) {
    this.reload()
    const prev = this.mergeQueue[String(key)] ?? null
    delete this.mergeQueue[String(key)]
    this.save()
    return prev
  }

  session(name) {
    return this.sessions[name] ?? null
  }

  record(name, patch) {
    const prev = this.sessions[name] ?? {}
    this.sessions[name] = { ...prev, ...patch, updatedAt: nowIso() }
    this.save()
    return this.sessions[name]
  }

  names() {
    return Object.keys(this.sessions)
  }

  // 收口时把执行会话的记录也收掉：只摘 watch 不删 sessions 的话，服务重启会按
  // sessions 重新登记，每轮还要去读这条已完结会话的状态（单实例下会切用户窗口）。
  delSession(name) {
    const k = String(name ?? "")
    if (!k || !this.sessions[k]) return false
    delete this.sessions[k]
    this.save()
    return true
  }

  // 按 target upsert 一条显式监听。
  setWatch(entry) {
    const list = this.watch
    const i = list.findIndex((w) => String(w.target) === String(entry.target))
    const merged = {
      target: String(entry.target),
      name: String(entry.name ?? entry.target),
      issueKey: entry.issueKey ?? null,
      repo: entry.repo ?? "",
      number: entry.number ?? null,
      notifyTo: entry.notifyTo ?? "",
      // 补派会话是谁登记监听的，谁就是父会话；sessions 查询靠它过滤当前会话。
      parent: String(entry.parent ?? list[i]?.parent ?? ""),
      addedAt: nowIso(),
    }
    if (i >= 0) {
      // 保留旧的 addedAt，其余字段以本次为准。
      merged.addedAt = list[i].addedAt ?? merged.addedAt
      list[i] = merged
    } else {
      list.push(merged)
    }
    this.save()
    return merged
  }

  delWatch(target) {
    const list = this.watch
    const i = list.findIndex((w) => String(w.target) === String(target))
    if (i < 0) return false
    list.splice(i, 1)
    this.save()
    return true
  }

  // 通知会话账本：{ "<会话名或convId>": { name, convId, kind, at, prs: ["repo#pr", ...] } }
  // 只记 foreman 自己新建的投递会话，用来在它报过的 PR 全部合完后自动归档。
  get notices() {
    return this.data.notices ?? (this.data.notices = {})
  }

  markNotice(key, info = {}) {
    this.reload()
    const prev = this.notices[key] ?? {}
    this.notices[key] = {
      name: String(info.name ?? prev.name ?? key),
      convId: String(info.convId ?? prev.convId ?? ""),
      kind: String(info.kind ?? prev.kind ?? ""),
      at: prev.at ?? nowIso(),
      prs: info.prs ?? prev.prs ?? [],
    }
    this.save()
    return this.notices[key]
  }

  delNotice(key) {
    this.reload()
    if (!this.notices[key]) return false
    delete this.notices[key]
    this.save()
    return true
  }

  // delWatchIssue 按工单摘监听：同一条单可能有多个会话（补派过就会有），一次摘一条。
  // 合并/关单后调用，别让已经收口的单继续被轮询（否则还会按指纹继续出通知）。
  delWatchIssue(issueKey) {
    const key = String(issueKey ?? "")
    if (!key) return false
    const list = this.watch
    const i = list.findIndex((w) => String(w.issueKey ?? "") === key)
    if (i < 0) return false
    list.splice(i, 1)
    this.save()
    return true
  }

  // 已入箱的可观察阶段。它不代表已送达；最终回复仍以 markNotified + markIdle 为准。
  markTaskObserved(target, phase, extra = {}) {
    this.reload()
    const key = String(target)
    const prev = this.notified[key] ?? {}
    this.notified[key] = {
      ...prev,
      observedPhase: String(phase ?? ""),
      observedAt: nowIso(),
      observedFingerprint: extra.fingerprint ?? prev.observedFingerprint ?? "",
    }
    this.save()
    return this.notified[key]
  }

  // 记录 (target, 指纹) 已通知，重启后不再重发。
  markNotified(target, fingerprint, extra = {}) {
    this.reload()
    const prev = this.notified[String(target)] ?? {}
    this.notified[String(target)] = {
      ...prev,
      fingerprint,
      at: nowIso(),
      phase: extra.phase ?? "",
      chars: extra.chars ?? 0,
      attempts: 0,
      failed: 0,
      lastError: "",
      ...extra,
    }
    this.save()
    return this.notified[String(target)]
  }

  // 发出去之前先记一笔：同一指纹的尝试次数 +1。dws 有时会「消息到了却报发送失败」，
  // 没有这笔账就会每轮 poll 重发一次，把调用方会话刷成重复通知。
  markAttempted(target, fingerprint, extra = {}) {
    this.reload()
    const key = String(target)
    const prev = this.notified[key] ?? {}
    const same = String(prev.fingerprint ?? "") === String(fingerprint ?? "")
    this.notified[key] = {
      fingerprint,
      at: nowIso(),
      phase: extra.phase ?? "",
      chars: extra.chars ?? 0,
      attempts: (same ? Number(prev.attempts ?? 0) : 0) + 1,
      failed: Number(prev.failed ?? 0) + (same ? 1 : 1),
      lastError: extra.error ?? prev.lastError ?? "",
    }
    this.save()
    return this.notified[key]
  }

  // 收工这一轮已经处理过（通知了，或者没什么可通知）：记一笔 idle。
  // 之后每轮只看侧边栏的 running，不再逐条 dws status —— 读 status 会 goto，
  // 把用户窗口一遍遍拽到被监听的会话上。
  markIdle(target, extra = {}) {
    this.reload()
    const key = String(target)
    const prev = this.notified[key] ?? {}
    this.notified[key] = {
      ...prev,
      ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      idle: true,
      idleAt: nowIso(),
    }
    this.save()
    return this.notified[key]
  }

  // 侧边栏又把它报成 running：清掉 idle，等下一次收工重新判一轮。
  clearIdle(target) {
    this.reload()
    const key = String(target)
    const prev = this.notified[key]
    if (!prev || !prev.idle) return prev ?? null
    prev.idle = false
    prev.wokeAt = nowIso()
    this.save()
    return prev
  }

  // 侧边栏里根本没有这条（已归档/已收起）：落 gone，之后不再为它读 status。
  // dws status 切不过去只会报「侧边栏里没有任务」，每 20s 刷一次日志、白拽一次窗口。
  markGone(target) {
    this.reload()
    const key = String(target)
    const prev = this.notified[key] ?? {}
    this.notified[key] = { ...prev, gone: true, goneAt: nowIso() }
    this.save()
    return this.notified[key]
  }

  // 它又出现在侧边栏里了：清掉 gone，这一轮重新判一次（中间可能又跑完过一轮）。
  clearGone(target) {
    this.reload()
    const key = String(target)
    const prev = this.notified[key]
    if (!prev || !prev.gone) return prev ?? null
    prev.gone = false
    delete prev.goneAt
    this.save()
    return prev
  }

  // reload 从盘上重读：服务里一次 notify 可能耗时几十秒，期间别的进程（run/CLI）
  // 也在写同一个 state.json，长时间持有快照再整文件覆盖会把它们的改动抹掉。
  reload() {
    const d = load(this.file)
    this.data = d
    return this.data
  }

  save() {
    this.data.version = this.data.version ?? 1
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n")
    fs.renameSync(tmp, this.file)
  }
}

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"))
    return d && typeof d === "object" ? d : { version: 1 }
  } catch {
    return { version: 1 }
  }
}
