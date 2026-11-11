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
  markPrSeen(key, pr = {}) {
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
    }
    this.save()
    return this.prSeen[key]
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

  // 记录 (target, 指纹) 已通知，重启后不再重发。
  markNotified(target, fingerprint, extra = {}) {
    this.reload()
    this.notified[String(target)] = {
      fingerprint,
      at: nowIso(),
      phase: extra.phase ?? "",
      chars: extra.chars ?? 0,
      attempts: 0,
      failed: 0,
      lastError: "",
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
