// zcode（ZCode CLI）会话适配器：所有「zcode 才有的事」都收在这里，workflow 不直接碰 zcode CLI。
//
// 收进来的 zcode 特殊性：
// - headless 一轮是阻塞调用：openExecution/send 等到这轮跑完才返回（豆包是先开会话再轮询）；
// - 通知/steer 不等跑完：排到该会话当前轮次之后，后台跑（等价 dws msg --mode queue 的排队语义）；
// - 无单实例窗口，可并行多张单，不需要 window-busy 护栏；
// - 名字/伪 id/sess id 的互查与会话账本都在驱动层（zcodedrv）。
import path from "node:path"
import { expandHome } from "../../util.mjs"
import { ZcodeDriver } from "../../zcodedrv.mjs"

export class ZcodeSessionAdapter {
  constructor({ cfg = {}, log = () => {} } = {}) {
    const z = cfg.zcode ?? {}
    this.cfg = cfg
    this.log = log
    // 账本默认放 stateFile 同目录（state.json 旁边），服务重启后旧会话仍可按 id/名字解析。
    const ledger = String(z.ledger ?? "").trim()
      || path.join(path.dirname(path.resolve(expandHome(String(cfg.stateFile ?? "state.json")))), "zcode-sessions.json")
    this.driver = new ZcodeDriver({ bin: z.bin ?? "", mode: z.mode ?? "", ledger, log })
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

  // start：解析 zcode bin 并探活（doctor --start 用）。
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
