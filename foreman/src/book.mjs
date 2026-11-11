// 状态账本：~/.foreman/state.json。只记编排需要的东西（工单到哪一步、哪个会话、哪条分支）。
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
