// noop 会话适配器：cfg.agent === "noop" 时的执行载体——不开任何真实会话、不碰豆包。
// 所有开/说/归档动作都立刻「成功」并返回一个假会话 id：inbox 投递照常走完（事件记 done），
// clean / tasks / orch show 这类收尾与只读命令在豆包不可用时照常工作。
// 代价是没人真正干活：工单不会推进、产出为空——这是选 noop 时的预期。
export class NoopSessionAdapter {
  constructor({ cfg = {}, log = () => {} } = {}) {
    this.cfg = cfg
    this.log = log
    this.capabilities = { singleInstance: false, noop: true }
    this.seq = 0
  }

  #convId(name) {
    this.seq += 1
    return `noop-${String(name || "session").replace(/\s+/g, "-")}-${this.seq}`
  }

  // ---- SessionAdapter 契约 ----
  openExecution({ name, repo = "" } = {}) {
    const convId = this.#convId(name)
    this.log(`noop open ${name}${repo ? `（${repo}）` : ""} → ${convId}（不投递）`)
    return { ok: true, convId, name, noop: true }
  }

  resumeExecution({ name } = {}) {
    this.log(`noop resume ${name}（不投递）`)
    return { ok: true, name, noop: true }
  }

  deliver({ name } = {}) {
    const convId = this.#convId(name)
    this.log(`noop deliver ${name} → ${convId}（不投递）`)
    return { ok: true, convId, name, noop: true }
  }

  // 状态永远「已完成但为空」：watch/poll 的指纹去重会挡住重复通知，不会反复触发投递。
  status(target) {
    return { name: String(target ?? ""), streaming: false, finished: true, chars: 0, reply: { finished: true } }
  }

  info(target) {
    return { name: String(target ?? ""), messages: [], running: false, lastReply: "" }
  }

  notify() {
    return { ok: true, noop: true }
  }

  steer(target) {
    this.log(`noop steer ${target}（不投递）`)
    return { ok: true, noop: true }
  }

  queue() {
    return { ok: true, noop: true }
  }

  async runningMap() {
    return {}
  }

  async archive(target) {
    this.log(`noop archive ${target}（无需归档）`)
    return { ok: true, noop: true }
  }

  // ---- 兼容旧调用面（orchestrator / 既有代码直接当 DwsDriver 用） ----
  open(args) {
    return this.openExecution(args)
  }

  send(name, prompt) {
    return this.resumeExecution({ name, prompt })
  }

  openNew(args) {
    return this.deliver(args)
  }

  start() {
    return { ok: true, noop: true }
  }

  stop() {
    return { ok: true, noop: true }
  }

  // ---- 豆包特有的护栏：noop 没有单实例，永远不忙 ----
  async busyWatchers() {
    return []
  }

  async on() {}
}
