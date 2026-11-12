// 通用 workflow 引擎：把生命周期事件与适配器组装起来，给 service 提供流程级动作。
//
// service 不再关心「豆包怎么开会话、herdr 怎么清工作区」：
// 它只调 engine.session / engine.tracker / engine.workspace，以及在关键节点 emit 事件。
import { Lifecycle, EVENTS } from "./lifecycle.mjs"
import { DoubaoSessionAdapter } from "./adapters/doubao.mjs"
import { GiteaTrackerAdapter } from "./adapters/gitea.mjs"
import { HerdrWorkspaceAdapter } from "./adapters/herdr.mjs"

export class WorkflowEngine {
  constructor({ cfg, session = null, tracker = null, workspace = null, hooks = null, log = () => {} } = {}) {
    this.cfg = cfg
    this.log = log
    this.session = session ?? new DoubaoSessionAdapter({ cfg, log })
    this.tracker = tracker ?? new GiteaTrackerAdapter({})
    this.workspace = workspace ?? new HerdrWorkspaceAdapter({ cfg, log })
    this.lifecycle = new Lifecycle({
      adapters: { session: this.session, tracker: this.tracker, workspace: this.workspace },
      hooks: hooks ?? cfg.workflow?.hooks ?? {},
      log,
    })
  }

  emit(event, payload) {
    return this.lifecycle.emit(event, payload)
  }

  stages() {
    return this.lifecycle.stages()
  }

  // 合并后的通用收尾：清工作区 → workspace.cleaned → pr.merged（豆包 adapter 据此归档执行会话）。
  // 任何适配器组合都走这条：清理失败只记 notes，不影响 merged 的事实。
  async afterMerge({ watcher, merge, book }) {
    const issueKey = watcher?.issueKey || (merge.issueNumber ? `${merge.repo}#${merge.issueNumber}` : "")
    const issueRec = issueKey ? (book.issue(issueKey) ?? {}) : {}
    const repoCfg = (this.cfg.repos ?? []).find((r) => r.repo === merge.repo)
    let cleanup
    try {
      if (issueRec.worktree && repoCfg?.dir) {
        cleanup = await this.workspace.cleanup({ repoDir: repoCfg.dir, worktree: issueRec.worktree, branch: issueRec.branch ?? "" })
      } else {
        cleanup = { notes: ["没有 worktree 或仓库目录记录，跳过本地清理"] }
      }
    } catch (e) {
      cleanup = { notes: [`本地清理失败：${e.message}`] }
    }
    for (const n of cleanup.notes ?? []) this.log(`合并收尾 ${issueKey || merge.key}：${n}`)

    await this.emit(EVENTS.cleanup, { issueKey, key: merge.key, cleanup })
    await this.emit(EVENTS.merge, {
      issueKey,
      key: merge.key,
      repo: merge.repo,
      pr: merge.pr,
      prUrl: merge.prUrl,
      target: watcher?.target,
      cleanup,
    })
    return cleanup
  }
}
