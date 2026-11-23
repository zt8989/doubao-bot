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
import { runNodeCleanup, resolveIssueKey } from "./cleaners.mjs"

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
  // stages：只跑指定的收尾节点（如 ["merge","pr-open"]），缺省全跑——merge/clean 拆分后，
  // `pr merge` 默认只做合并落账（merge + pr-open），close/cleanup/archive 归 `foreman clean`。
  async afterMerge({ watcher, merge, book, workflow = "", stages = null } = {}) {
    const want = Array.isArray(stages) && stages.length ? (s) => stages.includes(s) : () => true
    const repo = String(merge?.repo ?? "")
    const pr = Number(merge?.pr ?? 0)
    const key = String(merge?.key ?? `${repo}#${pr}`)
    const wf = workflow || "own"
    // 关联工单：调用方给的 → 合并任务里的工单号 → 按 PR 反查（run 或账本）。
    // 没有这条，没传 --issue 的合并就没有 close 节点可用，工单会一直停在 pr-open。
    const issueKey = String(watcher?.issueKey ?? "")
      || (Number(merge?.issueNumber) ? `${repo}#${merge.issueNumber}` : "")
      || this.issueKeyForPr(book, repo, pr)
    const issueNo = Number(String(issueKey).split("#")[1] ?? 0) || 0
    const ctx = {
      book,
      cfg: this.cfg,
      repo,
      pr,
      prUrl: String(merge?.prUrl ?? ""),
      issueKey,
      issueNo,
      key,
      target: String(watcher?.target ?? ""),
      tracker: this.tracker,
      session: this.session,
      workspace: this.workspace,
      log: this.log,
    }
    const notes = []
    const ran = []
    const run = async (stage, op = null) => {
      const out = await runNodeCleanup(stage, ctx, { paused: this.paused(stage) })
      if (out.notes.length) notes.push(...out.notes)
      ran.push(stage)
      if (op) {
        finishOperation(this, op, out.notes.some((n) => /失败/.test(n)) ? "failed" : "success", out.notes.join("；"))
      }
      return out
    }

    // merge 节点：合并事实落账（mergeAsk / 合并队列），然后落 pr.merged。
    await run("merge")
    await this.emit(EVENTS.merge, {
      issueKey,
      key,
      workflow: wf,
      repo,
      pr,
      prUrl: ctx.prUrl,
      target: watcher?.target,
    })

    // close 节点：关单 + 摘标签 + 工单 done（没有关联工单时自己会写一句跳过原因）。
    // 放在回收工作区之前：先确认这张单真的收了，再去拆它留下的工作区。
    if (want("close")) {
      await run("close")
      await this.emit(EVENTS.close, { issueKey, key, pr, issue: issueNo, target: watcher?.target, workflow: wf })
    }

    // 合并后按账本自清：pr-open（PR 记成 merged）→ dispatch（摘监听）→ workspace（删工作区）。
    // 清理器都幂等，不能按旧流程实例的 reached 阶段过滤：服务重启后实例常只恢复到 pr-open，
    // 若因此跳过 workspace，就会留下 herdr workspace 与 git worktree。
    const pre = (wf === "review" ? [] : ["workspace", "dispatch", "pr-open"]).filter(want)
    for (const stage of [...pre].reverse()) {
      const op = stage === "workspace"
        ? startOperation(this, "cleanup", `清理工作区 ${issueKey || key}`, {
          key: issueKey || key,
          detail: (issueKey && book?.issue ? book.issue(issueKey) ?? {} : {}).worktree || "关 herdr 工作区、删 worktree 与本地分支",
        })
        : null
      await run(stage, op)
    }

    // cleanup 节点：兜底清扫（空壳目录、git 元数据、队列残留）。
    if (want("cleanup")) {
      const op = startOperation(this, "cleanup", `兜底清扫 ${issueKey || key}`, { key: issueKey || key, detail: "空目录 / worktree 元数据 / 合并队列残留" })
      await run("cleanup", op)
      await this.emit(EVENTS.cleanup, { issueKey, key, workflow: wf, cleanup: { notes } })
    }

    // archive 节点：执行会话由它自己归档（不再挂在 pr.merged 上顺手做）。
    if (want("archive")) {
      const aop = startOperation(this, "archive", "归档执行会话", { key: issueKey || key, detail: String(watcher?.target ?? "") })
      await run("archive", aop)
      await this.emit(EVENTS.archive, { issueKey, key, workflow: wf, target: watcher?.target })
    }

    return { notes, nodes: ran, issueKey, issueNo }
  }

  // 按 PR 反查它属于哪张工单：先查流程实例，再查账本里 pr 对得上的记录。
  issueKeyForPr(book, repo, pr) {
    const fromRun = this.lifecycle.runWithPr(repo, pr)
    if (fromRun) return String(fromRun.key)
    return resolveIssueKey({ runs: [], book, repo, pr })
  }
}

