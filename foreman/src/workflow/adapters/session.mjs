// SessionAdapter 契约：workflow 对「执行会话 / 通知会话」的全部要求。
// 任何聊天载体（豆包、飞书、Slack…）只要实现这些方法，就能接进同一条生命周期。
//
// 必需：
//   openExecution({ name, repo, prompt })  开一条执行会话并等首轮（返回 { convId }）
//   resumeExecution({ name, prompt })      往已有执行会话里续说
//   deliver({ name, prompt, noWait })      开一条通知/编排会话，把首句投进去
//   status(target)                         读会话状态（streaming/finished/chars/head/tail）
//   info(target)                           读会话内容（至少给 lastReply；有 messages 时可回传最近对话）
//   notify(target, text)                   往既有会话里塞一条文本（existing 模式用）
// 可选：
//   runningMap()                           不打扰用户地读出「哪些会话还在跑」（豆包=侧边栏）
//   archive(target)                        归档收起会话
//   on(event, payload)                     生命周期钩子
// 能力标记：
//   capabilities.singleInstance            单实例桌面应用（同时只能有一条前台会话，需要 window-busy 护栏）
import { DoubaoSessionAdapter } from "./doubao.mjs"
import { NoopSessionAdapter } from "./noop.mjs"
import { ZcodeSessionAdapter } from "./zcode.mjs"

// 按配置选执行载体：agent = "noop"（默认，不开会话不碰任何前端）| "dws"（豆包桌面端）| "zcode"（ZCode CLI）。
// 豆包只是可选的 agent 之一：换载体不动 workflow，clean/tasks 这类命令在 noop 下照常工作。
// 默认 noop：没写 agent 的机器不自动拉起豆包（写错值也兜底到 noop，安全第一）。
export function makeSessionAdapter(cfg = {}, { driver = null, log = () => {} } = {}) {
  const agent = String(cfg.agent ?? "").trim().toLowerCase()
  if (agent === "zcode") return new ZcodeSessionAdapter({ cfg, log })
  if (agent === "noop") return new NoopSessionAdapter({ cfg, log })
  if (agent === "dws") return new DoubaoSessionAdapter({ driver, cfg, log })
  return new NoopSessionAdapter({ cfg, log })
}

export function assertSessionAdapter(adapter, name = "session") {
  const missing = ["openExecution", "resumeExecution", "deliver", "status", "info", "notify"]
    .filter((m) => typeof adapter?.[m] !== "function")
  if (missing.length) throw new Error(`${name} 适配器缺少方法：${missing.join("、")}`)
  return adapter
}
