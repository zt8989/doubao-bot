// 豆包（dws）会话适配器：所有「豆包才有的事」都收在这里，workflow 不再直接碰 dws。
//
// 收进来的豆包特殊性：
// - 单实例桌面窗口：同时只有一条前台会话，派新会话前要看被监听的会话是不是还在跑（window-busy）；
// - 读状态会切窗口：优先用 runningMap() 读侧边栏，只有没在跑的才逐条 status；
// - 通知会话用 open --no-wait 新建（openNew），执行会话用 open / send；
// - 归档 = dws archive（会留一份 markdown 存档，不是删除）。
import { DwsDriver } from "../../dwsdrv.mjs"

export class DoubaoSessionAdapter {
  constructor({ driver = null, cfg = {}, log = () => {} } = {}) {
    this.driver = driver ?? new DwsDriver({ bin: cfg.dws?.bin ?? "dws", mode: cfg.dws?.mode ?? "local", model: cfg.dws?.model ?? "auto", log })
    this.cfg = cfg
    this.log = log
    this.capabilities = { singleInstance: true }
  }

  // ---- SessionAdapter 契约 ----
  openExecution({ name, repo = "", prompt }) {
    return this.driver.open({ name, repo, prompt })
  }

  resumeExecution({ name, prompt }) {
    return this.driver.send(name, prompt)
  }

  deliver({ name, prompt, noWait = true }) {
    return this.driver.openNew({ name, prompt, noWait })
  }

  // 兼容旧调用面（orchestrator / 既有测试直接当 DwsDriver 用）：语义与上面的契约方法一一对应。
  open(args) {
    return this.openExecution(args)
  }

  send(name, prompt) {
    return this.resumeExecution({ name, prompt })
  }

  openNew(args) {
    return this.deliver(args)
  }

  status(target) {
    return this.driver.status(target)
  }

  async info(target) {
    const info = await this.driver.info(target)
    // 契约通用 message：running 由 status 补（豆包无账本，读一次状态换算），Chat 页免猜。
    const status = await this.driver.status(target).catch(() => null)
    return { ...info, running: status?.streaming === true }
  }

  notify(target, text) {
    return this.driver.notify(target, text)
  }

  // steer：往编排会话里插工作会话的状态更新 / 失败续跑指令，不打断它当前那一轮。
  steer(target, text) {
    return this.driver.steer(target, text)
  }

  // queue：router agent巡检排到当前轮次之后，避免插入同一轮造成重复检查。
  queue(target, text) {
    return this.driver.queue(target, text)
  }

  runningMap() {
    return this.driver.runningMap()
  }

  archive(target) {
    return this.driver.archive(target)
  }

  // start：连接/检查窗口与登录态（doctor --start 用），透传驱动。
  start() {
    return this.driver.start()
  }

  // ---- 豆包特有的护栏 ----
  // 被监听的会话里还在跑的那些：单实例下这时候开新会话必然失败或写错会话。
  async busyWatchers(watcherIds = []) {
    if (typeof this.driver.runningMap !== "function") return []
    const sidebar = await this.runningMap()
    return watcherIds.filter((id) => sidebar?.[id]?.running)
  }

  // ---- 生命周期 ----
  // 归档不再挂在 pr.merged 上顺手做：archive 节点自己调 archive()，
  // 节点被暂停或没有 target 时就不归档，别的节点照走。
  async on() {}
}
