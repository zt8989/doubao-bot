// SessionAdapter 契约：workflow 对「执行会话 / 通知会话」的全部要求。
// 任何聊天载体（豆包、飞书、Slack…）只要实现这些方法，就能接进同一条生命周期。
//
// 必需：
//   openExecution({ name, repo, prompt })  开一条执行会话并等首轮（返回 { convId }）
//   resumeExecution({ name, prompt })      往已有执行会话里续说
//   deliver({ name, prompt, noWait })      开一条通知/编排会话，把首句投进去
//   status(target)                         读会话状态（streaming/finished/chars/head/tail）
//   info(target)                           读会话内容（至少给 lastReply）
//   notify(target, text)                   往既有会话里塞一条文本（existing 模式用）
// 可选：
//   runningMap()                           不打扰用户地读出「哪些会话还在跑」（豆包=侧边栏）
//   archive(target)                        归档收起会话
//   on(event, payload)                     生命周期钩子
// 能力标记：
//   capabilities.singleInstance            单实例桌面应用（同时只能有一条前台会话，需要 window-busy 护栏）
export function assertSessionAdapter(adapter, name = "session") {
  const missing = ["openExecution", "resumeExecution", "deliver", "status", "info", "notify"]
    .filter((m) => typeof adapter?.[m] !== "function")
  if (missing.length) throw new Error(`${name} 适配器缺少方法：${missing.join("、")}`)
  return adapter
}
