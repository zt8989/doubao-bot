// 通用 workflow 的生命周期：阶段、事件、钩子。
//
// 设计目标：把「捞单 → 建工作区 → 派活 → 监听 → 出结论 → 合并 → 清理 → 归档」这条链
// 从任何一个具体工具里抽出来。流程只认识下面这些事件，**不认识豆包、Gitea、herdr**；
// 具体工具差异全部落在 adapters/<工具>.mjs 里，适配器可以选择性地监听事件（on(event, payload)）。
//
// 新增一个接入方（比如飞书会话、Jira 工单）时：写一个满足 adapter 契约的类，
// 塞进 Lifecycle 的 adapters，流程本身不用改。

export const STAGES = [
  { stage: "pickup", event: "issue.picked", description: "捞到一张可接的工单" },
  { stage: "workspace", event: "workspace.ready", description: "worktree / 工作区就绪" },
  { stage: "dispatch", event: "session.dispatched", description: "执行会话已派出（首句送达）" },
  { stage: "watch", event: "session.finished", description: "执行会话跑完，拿到结论" },
  { stage: "conclude", event: "issue.concluded", description: "工单结论落账（done/failed/…）" },
  { stage: "merge", event: "pr.merged", description: "PR 已合并" },
  { stage: "cleanup", event: "workspace.cleaned", description: "herdr 工作区与 worktree 已清理" },
  { stage: "archive", event: "session.archived", description: "会话已归档收起" },
  { stage: "notify", event: "notice.delivered", description: "结论已投递给编排会话" },
]

export const EVENTS = Object.fromEntries(STAGES.map((s) => [s.stage, s.event]))

export function stageOf(event) {
  return STAGES.find((s) => s.event === event)?.stage ?? ""
}

// Lifecycle：事件总线 + 钩子 + 历史（最近 N 条，排障用）。
// - hooks：配置/调用方给的额外动作，形如 { "pr.merged": async (payload) => {} }
// - adapters：每个适配器可实现 on(event, payload)，在 hooks 之后按注册顺序调用；
//   例如豆包 adapter 在 pr.merged 时归档执行会话，herdr adapter 在 pr.merged 时清工作区。
export class Lifecycle {
  constructor({ adapters = {}, hooks = {}, log = () => {}, historyLimit = 200 } = {}) {
    this.adapters = adapters
    this.hooks = hooks
    this.log = log
    this.historyLimit = historyLimit
    this.history = []
  }

  stages() {
    return STAGES.map((s) => ({ ...s }))
  }

  async emit(event, payload = {}) {
    const entry = { event, stage: stageOf(event), at: new Date().toISOString(), key: payload.issueKey ?? payload.key ?? "" }
    this.history.push(entry)
    if (this.history.length > this.historyLimit) this.history.shift()

    const hook = this.hooks?.[event]
    if (typeof hook === "function") await hook(payload)

    for (const [name, adapter] of Object.entries(this.adapters)) {
      if (typeof adapter?.on !== "function") continue
      try {
        await adapter.on(event, payload)
      } catch (e) {
        // 适配器的善后动作失败不打断主流程：已经合并的不会因为归档失败而变成没合并。
        this.log(`生命周期 ${event}：适配器 ${name} 处理失败 —— ${e.message}`)
      }
    }
    return entry
  }
}
