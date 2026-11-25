// zcode（ZCode CLI）会话适配器：所有「zcode 才有的事」都收在这里，workflow 不直接碰 zcode/herdr CLI。
//
// 载体：zcode TUI 常驻 herdr 窗格。openExecution/send 阻塞到这轮跑完（pane run 投递 + 轮询
// herdr 状态机）；通知/steer 投进 TUI 输入框自动排队、立即返回；无单实例窗口，可并行多张单；
// 会话可被人在 herdr 里围观/插手/批权限。名字/伪 id/paneId 的互查与会话账本都在驱动层（zcodedrv）。
import { ZcodeHerdrDriver, defaultLedgerPath } from "../../zcodedrv.mjs"

export class ZcodeSessionAdapter {
  constructor({ cfg = {}, log = () => {} } = {}) {
    const z = cfg.zcode ?? {}
    this.cfg = cfg
    this.log = log
    const ledger = String(z.ledger ?? "").trim() || defaultLedgerPath(cfg)
    this.driver = new ZcodeHerdrDriver({ herdrBin: cfg.herdr?.bin ?? "herdr", bin: z.bin ?? "", tuiBin: z.tuiBin ?? "", ledger, log })
    this.capabilities = { singleInstance: false }
  }

  // ---- SessionAdapter 契约 ----
  openExecution({ name, repo = "", prompt } = {}) {
    return this.driver.open({ name, repo, prompt })
  }

  resumeExecution({ name, prompt } = {}) {
    return this.driver.send(name, prompt)
  }

  deliver({ name, prompt, noWait = true } = {}) {
    return this.driver.openNew({ name, prompt, noWait })
  }

  status(target) {
    return this.driver.status(target)
  }

  info(target) {
    return this.driver.info(target)
  }

  notify(target, text) {
    return this.driver.notify(target, text)
  }

  steer(target, text) {
    return this.driver.steer(target, text)
  }

  queue(target, text) {
    return this.driver.queue(target, text)
  }

  runningMap() {
    return this.driver.runningMap()
  }

  archive(target) {
    return this.driver.archive(target)
  }

  // start：doctor --start 用——查 herdr 版本/server/runtime/插件四项。
  start() {
    return this.driver.start()
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

  // ---- zcode 没有的东西 ----
  // 无单实例护栏：zcode 是 CLI，随便并行。
  async busyWatchers() {
    return []
  }

  async on() {}
}
