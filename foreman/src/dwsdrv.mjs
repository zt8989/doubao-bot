// dws 驱动层：foreman 不碰豆包内部实现，一律通过 dws 的命令行把活儿派出去。
// 进程边界在 dws 这一侧，所以 dws 只负责“豆包会话”，编排只在这里。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { exec, extractJson, sleep } from "./util.mjs"

export class DwsError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, { code: "dws_error" }, extra)
  }
}

const APP_ERRORS = {
  app_busy: "豆包被用户自己开着的实例占住了（单实例），让对方 ⌘Q 退出后再跑",
  app_missing: "找不到豆包可执行文件",
  doubao_signed_out: "豆包没有登录",
  doubao_no_window: "豆包起来了但没有聊天页",
}

function classify(text) {
  const s = String(text ?? "")
  for (const key of Object.keys(APP_ERRORS)) {
    if (s.includes(key) || s.includes(APP_ERRORS[key])) return key
  }
  if (s.includes("超时") || s.includes("timeout")) return "dws_timeout"
  return ""
}

export class DwsDriver {
  constructor({ bin = "dws", mode = "local", model = "auto", log = () => {} } = {}) {
    this.bin = bin
    this.mode = mode
    this.model = model
    this.log = log
  }

  async run(args, { timeout = 600000 } = {}) {
    try {
      return await exec(this.bin, args, { timeout })
    } catch (e) {
      const blob = `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`
      const code = classify(blob)
      throw new DwsError(
        APP_ERRORS[code] || `dws ${args.slice(0, 2).join(" ")} 失败：${(e.stderr || e.stdout || e.message).trim().slice(-1200)}`,
        { code: code || "dws_error", args }
      )
    }
  }

  async json(args, opts) {
    const r = await this.run(args, opts)
    try {
      return extractJson(r.stdout)
    } catch (e) {
      throw new DwsError(`dws ${args[0]} 输出不是 JSON：${r.stdout.slice(-800)}`, { args })
    }
  }

  // open：新开一条工作任务并等第一轮回复跑完。prompt 走临时文件，避免超长命令行。
  async open({ name, repo = "", prompt }) {
    const tmp = writeTemp(prompt)
    this.log(`dws open ${name}（第一轮可能跑很久）`)
    const r = await this.json(
      ["open", "--name", name, ...(repo ? ["--repo", repo] : []), "--file", tmp],
      { timeout: 3600000 }
    )
    fs.rmSync(tmp, { force: true })
    return r
  }

  async send(name, text) {
    const tmp = writeTemp(text)
    const r = await this.json(["send", name, "--file", tmp], { timeout: 3600000 })
    fs.rmSync(tmp, { force: true })
    return r
  }

  // notify：把结果回给调用方会话。不带 handoff（不要往正文里塞接续说明），
  // 超时也短——通知失败不该把一整轮拖住。
  async notify(name, text) {
    const tmp = writeTemp(text)
    try {
      return await this.json(["send", name, "--file", tmp, "--handoff", "false"], { timeout: 180000 })
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  async status(name) {
    const r = await this.json(["status", name, "--json"], { timeout: 120000 })
    const list = Array.isArray(r?.status) ? r.status : [r?.status ?? r]
    return list.find((x) => x?.name === name) ?? list[0] ?? null
  }

  // info：读整段对话，只保留最后一条 assistant 文本（RESULT 就在里面）。
  async info(name) {
    const r = await this.json(["info", name, "--json"], { timeout: 180000 })
    const messages = Array.isArray(r?.messages) ? r.messages : []
    return { ...r, lastReply: lastAssistantText(messages) }
  }

  async stop(name) {
    return this.json(["stop", name], { timeout: 180000 })
  }

  // waitFinished：open/send 本身会等回复，但网络/超时情况下可能提前返回，
  // 这里再盯一段时间，直到 finished 或超时。
  async waitFinished(name, { timeoutMs, pollMs = 20000, onTick } = {}) {
    const started = Date.now()
    let last = null
    while (Date.now() - started < timeoutMs) {
      last = await this.status(name).catch(() => last)
      onTick?.(last)
      if (last?.reply?.finished) return last
      await sleep(pollMs)
    }
    return last
  }
}

function writeTemp(text) {
  const p = path.join(os.tmpdir(), `foreman-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(p, String(text ?? ""))
  return p
}

export function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const role = m?.role ?? m?.from ?? ""
    if (role === "assistant" || role === "bot" || role === "ai") return String(m.text ?? "")
  }
  const tail = messages[messages.length - 1]
  return String(tail?.text ?? "")
}
