// 会话簿：把“逻辑会话”（每个仓库一条）落到 state.json 里，
// 并负责和豆包窗口里的“工作任务”对上号。
//
// 豆包一次只有一个窗口、一个进行中的任务，所以“逻辑会话”和“工作任务”
// 不是一一对应：任务被换掉后再续这条会话，会新开一条工作任务并带上
// handoff 说明（进展都在分支/提交里，接着干就行）。
import fs from "node:fs"
import path from "node:path"
import { nowIso, readJson, writeJson, isFreshTask } from "./util.mjs"
import { Doubao, DoubaoError, STATE, NEW_TASK, NEW_TASK_IN_PROJECT, MODE, COUNTS } from "./doubao.mjs"

const EMPTY = { version: 1, sessions: {}, issues: {}, active: "" }

export class SessionBook {
  constructor(file) {
    this.file = file
    this.data = { ...EMPTY, ...(readJson(file, {}) ?? {}) }
    this.data.sessions ??= {}
    this.data.issues ??= {}
  }

  save() {
    writeJson(this.file, this.data)
  }

  session(name) {
    return this.data.sessions[name] ?? null
  }

  names() {
    return Object.keys(this.data.sessions)
  }

  record(name, patch) {
    const prev = this.data.sessions[name] ?? { name, openedAt: nowIso() }
    this.data.sessions[name] = { ...prev, ...patch, name, updatedAt: nowIso() }
    this.save()
    return this.data.sessions[name]
  }

  issue(key) {
    return this.data.issues[key] ?? null
  }

  setIssue(key, patch) {
    const prev = this.data.issues[key] ?? { key, createdAt: nowIso() }
    this.data.issues[key] = { ...prev, ...patch, key, updatedAt: nowIso() }
    this.save()
    return this.data.issues[key]
  }

  active() {
    return this.data.active ?? ""
  }

  setActive(name) {
    this.data.active = name ?? ""
    this.save()
  }
}

// replySummary 只留状态摘要，不把整段回复塞进 state.json。
export function replySummary(reply) {
  if (!reply) return null
  const text = reply.text ?? ""
  return {
    at: nowIso(),
    finished: !!reply.finished,
    status: reply.status ?? "",
    reason: reply.reason ?? "",
    error: reply.error ?? "",
    chars: text.length,
    head: text.slice(0, 120).replace(/\s+/g, " "),
    tail: text.slice(-600),
  }
}

export class SessionManager {
  constructor({ book, doubao = null, mode = "local", model = "auto" }) {
    this.book = book
    this.mode = mode
    this.model = model
    this.doubao = doubao
  }

  get client() {
    this.doubao ??= new Doubao()
    return this.doubao
  }

  // attached 判断“当前窗口里的任务”是不是这条逻辑会话。
  async attached(name) {
    let state
    try {
      state = await this.client.state()
    } catch (e) {
      return { attached: false, reason: e.code ?? "app_error", message: e.message }
    }
    const s = this.book.session(name)
    if (!state?.convId) return { attached: false, reason: "no_task", state }
    if (s?.convId && s.convId === state.convId) {
      return { attached: true, convId: state.convId, state }
    }
    return { attached: false, reason: "other_task", convId: state.convId, state }
  }

  // open 新建一条工作任务；给 prompt 就顺带把第一句发出去并等回复。
  // project 给了就开在豆包的那个项目下。noWait 只确认首句送达，不等第一轮回复。
  async open(name, { prompt = "", repo = "", mode, model, project = "", noWait = false, signal, onUpdate } = {}) {
    mode = mode ?? this.mode
    model = model ?? this.model
    // 记账前先记下当前窗口所在的会话 id：新建任务后必须确认窗口已经离开它，
    // 否则就把旧会话 id 错记到这条新会话头上（foreman-250 事故的根因）。
    const beforeState = await this.client.state()
    if (!beforeState.signedIn) throw new DoubaoError("豆包没有登录，请先在豆包窗口里登录", "doubao_signed_out")
    const beforeConvId = beforeState.convId

    let reply = null
    if (prompt) {
      // openTask 内部已经在 waitReply 回读处做过 isFreshTask 守卫，
      // 回读到旧会话 id 会抛 doubao_new_task，不会落到下面的记账。
      reply = await this.client.openTask(prompt, { mode, model, project, noWait, signal, onUpdate })
    } else {
      const page = await this.client.connect(signal)
      for (const [expr, what] of [
        [project ? NEW_TASK_IN_PROJECT(project) : NEW_TASK, project ? `在项目 ${project} 下新建工作任务` : "新建工作任务"],
        [MODE(mode === "cloud" ? "云电脑" : "本地电脑"), "切换模式"],
      ]) {
        const why = await page.eval(expr)
        if (why) throw new DoubaoError(`豆包${what}失败：${why}`, "doubao_ui")
      }
      const counts = await page.eval(COUNTS)
      // 不发首条消息时新页可能还没有会话 id（停在 /chat），只要离开了旧会话就接受。
      if (!isFreshTask(beforeConvId, counts.convId)) {
        throw new DoubaoError(
          `新建工作任务失败：窗口没有真正离开旧会话（新建前 convId=${beforeConvId || "(空)"}，新建后=${counts.convId || "(空)"}）`,
          "doubao_new_task"
        )
      }
      reply = { convId: counts.convId, reply: null }
    }

    const afterConvId = reply?.convId ?? ""
    // 最后一道记账守卫：绝不再用「当前窗口 convId」兜底——没拿到与旧 id 不同的新 id 就抛错，
    // 不往 state.json 里落假记录。带 prompt 的情况 openTask 已要求具体新 id；不带 prompt 时
    // 新页可能还没有 id（空串），但不能等于 beforeConvId。
    if (!isFreshTask(beforeConvId, afterConvId, { requireNewId: !!prompt })) {
      throw new DoubaoError(
        `新建工作任务失败：记账时拿到的会话 id（${afterConvId || "(空)"}）与新建前（${beforeConvId || "(空)"}）相同，拒绝落账。`,
        "doubao_new_task"
      )
    }
    const state = await this.client.state()
    this.book.record(name, {
      repo,
      project,
      convId: afterConvId,
      url: state.url,
      mode,
      model,
      reply: replySummary(reply?.reply),
    })
    this.book.setActive(name)
    return { session: this.book.session(name), reply: reply?.reply ?? null }
  }

  // send 在同一任务里续发；任务已经不在窗口里了就重开一条并带 handoff。
  async send(name, text, { handoff = "", signal, onUpdate } = {}) {
    const a = await this.attached(name)
    if (a.attached) {
      const { reply } = await this.client.send(text, { signal, onUpdate })
      this.book.record(name, { convId: reply.convId || a.convId, url: a.state.url, reply: replySummary(reply) })
      return { reattached: false, reply }
    }
    const prompt = handoff ? `${handoff}\n\n${text}` : text
    const opened = await this.open(name, { prompt, repo: this.book.session(name)?.repo, signal, onUpdate })
    return { reattached: true, reply: opened.reply }
  }

  async status(name) {
    const s = this.book.session(name)
    if (!s) return null
    const a = await this.attached(name)
    if (!a.attached) {
      return { session: s, live: false, why: a.reason, message: a.message ?? "", pageConvId: a.convId ?? "" }
    }
    const r = await this.client.read()
    this.book.record(name, { reply: replySummary(r) })
    return {
      session: this.book.session(name),
      live: true,
      reply: {
        finished: !!r.finished,
        streaming: !!r.reply && !r.finished,
        chars: (r.text ?? "").length,
        status: r.status,
        reason: r.reason,
        error: r.error,
        convId: r.convId,
      },
    }
  }

  async info(name) {
    const a = await this.attached(name)
    const s = this.book.session(name)
    if (!a.attached && s?.convId) {
      // 窗口在别的任务上：切过去再读
      await this.client.goto(s.convId)
      return { session: s, live: true, ...(await this.client.convo()) }
    }
    if (!a.attached) return { session: s, live: false, why: a.reason }
    const convo = await this.client.convo()
    return { session: this.book.session(name), live: true, ...convo }
  }

  // ---- 任意任务（按 convId，不依赖本地记录）----

  // windowTasks 列豆包窗口侧边栏里的全部工作任务。
  async windowTasks(signal) {
    return this.client.tasks(signal)
  }

  // windowProjects 列豆包侧边栏「项目」分组下的项目名。
  async windowProjects(signal) {
    return this.client.projects(signal)
  }

  // use 把窗口切到目标任务；给了 name 就顺带把 convId 记到本地。
  async use(convId, { name = "", signal } = {}) {
    await this.client.goto(convId, signal)
    if (name) this.book.record(name, { convId })
    return convId
  }

  async convStatus(convId, signal) {
    await this.client.goto(convId, signal)
    const r = await this.client.read(signal)
    return {
      convId,
      finished: !!r.finished,
      streaming: !!r.reply && !r.finished,
      chars: (r.text ?? "").length,
      status: r.status,
      reason: r.reason,
      error: r.error,
      head: (r.text ?? "").slice(0, 160),
    }
  }

  async convInfo(convId, signal) {
    await this.client.goto(convId, signal)
    return { live: true, ...(await this.client.convo(signal)) }
  }

  async convSend(convId, text, { signal, onUpdate } = {}) {
    await this.client.goto(convId, signal)
    const { reply } = await this.client.send(text, { signal, onUpdate })
    return { convId: reply.convId || convId, reply }
  }

  // convSendAck 同 convSend，但只确认送达、不等回复：通知走这条，
  // 免得对面迟迟不回把调用方拖到超时，进而把同一条通知再发一遍。
  async convSendAck(convId, text, { signal } = {}) {
    await this.client.goto(convId, signal)
    return this.client.sendAck(text, { signal })
  }

  // stop 中断目标任务；没在跑返回 false。有对应本地会话就记上 stopped 标记。
  async stop(convId, { name = "", signal } = {}) {
    const stopped = await this.client.stop(convId, signal)
    const s = this.book.session(name || convId)
    if (stopped && (name || s)) this.book.record(name || convId, { stoppedAt: nowIso() })
    return { convId, stopped }
  }

  // convSteer 跑动中向目标任务追加指令（Command+Enter，不打断）。
  async convSteer(convId, text, { signal } = {}) {
    await this.client.goto(convId, signal)
    return this.client.steer(text, { signal })
  }

  // archive 归档一条任务：先把整段对话落到归档目录（给了 dir 才落盘），
  // 再把豆包侧边栏里的这条收起；本地有对应会话就记上 archived 标记。
  async archive(convId, { name = "", dir = "", signal } = {}) {
    const tasks = (await this.windowTasks(signal)) ?? []
    const t = tasks.find((x) => x.id === convId)
    const title = t?.title || ""
    await this.client.goto(convId, signal)
    const convo = await this.client.convo(signal)
    const messages = convo.messages?.length ?? 0
    let file = ""
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10)
      const safe = String(title || "未命名").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
      file = path.join(dir, `${stamp}-${convId}-${safe || "task"}.md`)
      const head = [
        `# ${title || "未命名任务"}`,
        ``,
        `- 任务 id：${convId}`,
        `- 归档时间：${nowIso()}`,
        `- 消息数：${messages}`,
        ``,
        `---`,
        ``,
      ].join("\n")
      fs.writeFileSync(file, head + transcript(convo) + "\n")
    }
    await this.client.archive(convId, signal)
    this.book.record(name || convId, { convId, archived: true, archivedAt: nowIso(), title })
    return { convId, title, file, messages }
  }

  close() {
    this.client.close()
  }
}

export function transcript(convo) {  const lines = []
  for (const m of convo.messages ?? []) {
    lines.push(
      `### ${m.role === "user" ? "我" : "豆包"}${m.finished ? "" : "（未完成）"}${
        m.error ? "（错误：" + m.error + "）" : ""
      }`
    )
    if (m.reasoning) lines.push(`> 思考：${m.reasoning.replace(/\n/g, "\n> ")}`)
    lines.push(m.text || "（空）")
    lines.push("")
  }
  return lines.join("\n")
}

// matchTask 按标题在侧边栏任务里找一条：先精确匹配，再唯一包含匹配。
// 找不到或命中多条都返回 null，由调用方决定是报错还是列出候选。
export function matchTask(tasks, target) {
  const want = String(target ?? "").trim()
  if (!want) return null
  const list = (tasks ?? []).filter((t) => t && t.id)
  const exact = list.filter((t) => String(t.title ?? "").trim() === want)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const loose = list.filter((t) => String(t.title ?? "").includes(want))
  return loose.length === 1 ? loose[0] : null
}

export function ensureStateDir(file) {
  fs.mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true })
}
