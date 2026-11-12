// 通用 workflow 引擎：把生命周期事件与适配器组装起来，给 service 提供流程级动作。
//
// service 不再关心「豆包怎么开会话、herdr 怎么清工作区」：
// 它只调 engine.session / engine.tracker / engine.workspace，以及在关键节点 emit 事件。
import { Lifecycle, EVENTS, STAGES } from "./lifecycle.mjs"
import { DoubaoSessionAdapter } from "./adapters/doubao.mjs"
import { GiteaTrackerAdapter } from "./adapters/gitea.mjs"
import { HerdrWorkspaceAdapter } from "./adapters/herdr.mjs"
import { startOperation, finishOperation } from "../operations.mjs"
import { isPaused, setNodePaused, bumpNode, nodeCounts } from "./nodes.mjs"

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

  // 节点级暂停：只停这一个阶段的自动动作，整条 workflow 照走。
  paused(stage) {
    if (!this.cfg?.stateFile) return false
    return isPaused(this.cfg.stateFile, stage)
  }

  allow(stage) {
    return !this.paused(stage)
  }

  setPaused(stage, paused) {
    return setNodePaused(this.cfg.stateFile, stage, paused)
  }

  // 首页「分配任务」用的节点表：定义 + 是否 auto + 暂停状态 + 累计执行次数。
  nodes() {
    const counts = this.cfg?.stateFile ? nodeCounts(this.cfg.stateFile) : {}
    return STAGES.map((s) => {
      const c = counts[s.stage] ?? {}
      return {
        stage: s.stage,
        event: s.event,
        auto: s.auto === true,
        workflows: [...s.workflows],
        description: s.description,
        paused: this.paused(s.stage),
        count: Number(c.count ?? 0),
        lastAt: c.lastAt ?? "",
        firstAt: c.firstAt ?? "",
        detail: c.detail ?? "",
      }
    })
  }

  async emit(event, payload) {
    const entry = await this.lifecycle.emit(event, payload)
    // 自动节点每执行一次累计 +1（只增不减）：暂停、重启、换天都不归零。
    const def = STAGES.find((s) => s.event === event)
    if (def?.auto && this.cfg?.stateFile) {
      bumpNode(this.cfg.stateFile, def.stage, { detail: payload?.detail ?? payload?.status ?? "" })
    }
    return entry
  }

  stages() {
    return this.lifecycle.stages()
  }

  // 两条流程的定义（own 自有工单 / review 他人 PR），status 与文档都从这里取。
  workflows() {
    return this.lifecycle.workflows()
  }

  // 在跑的流程实例：自动接单的容量按 active("own").length 算，同时最多两条。
  active(workflow = "") {
    return this.lifecycle.active(workflow)
  }

  runs(limit = 20) {
    return this.lifecycle.runsList(limit)
  }

  // 服务重启后从账本把在跑的工单恢复成流程实例，不然容量会算成 0 又去重复派单。
  restore(book) {
    return this.lifecycle.restore(book?.issues ?? {})
  }

  // 合并后的通用收尾：清工作区 → workspace.cleaned → pr.merged（豆包 adapter 据此归档执行会话）。
  // 任何适配器组合都走这条：清理失败只记 notes，不影响 merged 的事实。
  // workflow：这条 PR 是哪条流程来的（own 自己的单 / review 别人的 PR）；共用阶段靠它落痕。
  async afterMerge({ watcher, merge, book, workflow = "" }) {
    const issueKey = watcher?.issueKey || (merge.issueNumber ? `${merge.repo}#${merge.issueNumber}` : "")
    const issueRec = issueKey ? (book.issue(issueKey) ?? {}) : {}
    const repoCfg = (this.cfg.repos ?? []).find((r) => r.repo === merge.repo)
    let cleanup
    // 清理节点被暂停：这一步先跳过（只写 notes），流程照走，后面的关单/归档不受影响。
    if (this.paused("cleanup")) {
      cleanup = { notes: ["清理节点已暂停，跳过本地清理"] }
      this.log(`合并收尾 ${issueKey || merge.key}：清理节点已暂停，跳过本地清理`)
      await this.emit(EVENTS.merge, {
        issueKey,
        key: merge.key,
        workflow,
        repo: merge.repo,
        pr: merge.pr,
        prUrl: merge.prUrl,
        target: watcher?.target,
        cleanup,
      })
      return cleanup
    }
    const op = startOperation(this, "cleanup", `清理工作区 ${issueKey || merge.key}`, {
      key: issueKey || merge.key,
      detail: issueRec.worktree || "检查 herdr 工作区与 git worktree",
    })
    try {
      if (issueRec.worktree && repoCfg?.dir) {
        cleanup = await this.workspace.cleanup({ repoDir: repoCfg.dir, worktree: issueRec.worktree, branch: issueRec.branch ?? "" })
      } else {
        cleanup = { notes: ["没有 worktree 或仓库目录记录，跳过本地清理"] }
      }
    } catch (e) {
      cleanup = { notes: [`本地清理失败：${e.message}`] }
    }
    finishOperation(this, op, cleanup.notes?.some((n) => /失败/.test(n)) ? "failed" : "success", (cleanup.notes ?? []).join("；"))
    for (const n of cleanup.notes ?? []) this.log(`合并收尾 ${issueKey || merge.key}：${n}`)

    await this.emit(EVENTS.cleanup, { issueKey, key: merge.key, workflow, cleanup })
    await this.emit(EVENTS.merge, {
      issueKey,
      key: merge.key,
      workflow,
      repo: merge.repo,
      pr: merge.pr,
      prUrl: merge.prUrl,
      target: watcher?.target,
      cleanup,
    })
    return cleanup
  }
}
