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

  // openNew：新开一条会话，把内容作为首句投递进去。noWait（默认）只确认首句送达、
  // 不等第一轮回复——投递完就返回，别把服务的轮询拖到超时。
  async openNew({ name, prompt, noWait = true }) {
    const tmp = writeTemp(prompt)
    try {
      this.log(`dws open ${name}（新建会话投递${noWait ? "，不等回复" : ""}）`)
      return await this.json(
        ["open", "--name", name, "--file", tmp, ...(noWait ? ["--no-wait"] : [])],
        { timeout: noWait ? 300000 : 3600000 }
      )
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  async send(name, text) {
    const tmp = writeTemp(text)
    const r = await this.json(["send", name, "--file", tmp], { timeout: 3600000 })
    fs.rmSync(tmp, { force: true })
    return r
  }

  // notify：把结果回给调用方会话。不带 handoff（不要往正文里塞接续说明），
  // 用 --no-wait 只确认送达：通知不需要对面的回复，等回复会白占轮询，
  // 对面迟迟不回还会被判成超时失败、再补发一条（同一条 done 推两次就是这么来的）。
  async notify(name, text) {
    const tmp = writeTemp(text)
    try {
      return await this.json(["send", name, "--file", tmp, "--handoff", "false", "--no-wait"], { timeout: 60000 })
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  // runningMap：只读侧边栏（dws list --json），**不切窗口**。
  // 逐条 dws status 会把窗口 goto 到被监听的会话——服务每 20s 轮询时用户窗口就被拽走。
  // 返回 { <会话id>: { running, title, active } }；读不到时抛错，由调用方退化回老行为。
  async runningMap() {
    const r = await this.json(["list", "--json"], { timeout: 60000 })
    const out = {}
    for (const t of r?.tasks ?? []) {
      if (t?.id) out[String(t.id)] = { running: t.running === true, title: t.title ?? "", active: t.active === true }
    }
    return out
  }

  // archive：归档收起会话（dws 会留一份 markdown 存档，不是删除）。合并完成后由生命周期调用。
  async archive(name) {
    return this.run(["archive", name], { timeout: 60000 })
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
