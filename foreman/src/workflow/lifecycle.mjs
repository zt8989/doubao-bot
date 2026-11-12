// 通用 workflow 的生命周期：阶段、事件、钩子。
//
// 这里定义**两条**生命周期，而不是一条大链路：
//
//   own     自有工单：作者是自己的单。接单 → 建工作区 → 派活 → 开发 → 出 PR → 合并 → 关单。
//   review  他人 PR：PR 是别人开的。扫到 → 核对工单与改动 → 合并 → 关单。
//
// 两条流程**后半段共用**（merge / close / cleanup / archive / notify），前半段完全不同：
// own 从一张工单开始（issue.picked），review 从一条 PR 开始（pr.scanned），不接单、不建 worktree。
// 所以「发出一个事件」时要把 workflow 带上（own / review）；共用阶段光看事件名分不出是哪条流程。
//
// 流程只认识下面这些事件，**不认识豆包、Gitea、herdr**；具体工具差异全部落在
// adapters/<工具>.mjs 里，适配器可以选择性地监听事件（on(event, payload)）。
//
// 新增一个接入方（比如飞书会话、Jira 工单）时：写一个满足 adapter 契约的类，
// 塞进 Lifecycle 的 adapters，流程本身不用改。新增一条流程时：在 STAGE_CATALOG
// 里加阶段（如果还没有），在 WORKFLOWS 里拼出它的阶段顺序。

// 阶段目录：一个阶段只定义一次（名字 → 事件 + 含义），两条流程按名字引用。
export const STAGE_CATALOG = {
  pickup: { event: "issue.picked", auto: true, description: "捞到一张可接的工单（作者是自己，或无人认领）" },
  workspace: { event: "workspace.ready", auto: true, description: "worktree / 工作区就绪" },
  dispatch: { event: "session.dispatched", auto: true, description: "执行会话已派出（首句送达）" },
  develop: { event: "session.finished", auto: false, description: "开发会话跑完，拿到结论（done / blocked / …）" },
  conclude: { event: "issue.concluded", auto: true, description: "工单结论落账（done/failed/…）" },
  "pr-open": { event: "pr.opened", auto: false, description: "会话自测通过并 push，PR 已开" },
  scan: { event: "pr.scanned", auto: true, description: "扫到一条别人的 open PR" },
  review: { event: "pr.reviewed", auto: false, description: "核对过关联工单与改动，定下合不合" },
  merge: { event: "pr.merged", auto: true, description: "PR 已合并" },
  close: { event: "issue.closed", auto: true, description: "关联工单已关闭（关单）" },
  cleanup: { event: "workspace.cleaned", auto: true, description: "herdr 工作区与 worktree 已清理" },
  archive: { event: "session.archived", auto: true, description: "会话已归档收起" },
  notify: { event: "notice.delivered", auto: true, description: "结论已投递给编排会话" },
}

// 两条流程：id 是落账与排障用的短名，stages 是阶段目录里的名字，顺序就是流程顺序。
export const WORKFLOWS = {
  own: {
    id: "own",
    name: "自有工单",
    description: "作者是自己的单：接单 → 开发 → 出 PR → 合并 → 关单",
    stages: ["pickup", "workspace", "dispatch", "develop", "conclude", "pr-open", "merge", "close", "cleanup", "archive", "notify"],
  },
  review: {
    id: "review",
    name: "他人 PR",
    description: "别人的 PR：扫到 → 核对 → 合并 → 关单",
    stages: ["scan", "review", "merge", "close", "cleanup", "archive", "notify"],
  },
}

// 一条流程展开成 [{ stage, event, description }]。
export function stagesOf(workflow) {
  const wf = typeof workflow === "string" ? WORKFLOWS[workflow] : workflow
  if (!wf) return []
  return wf.stages.map((name) => {
    const def = STAGE_CATALOG[name]
    if (!def) throw new Error(`未定义的阶段 ${name}（流程 ${wf.id}）`)
    return { stage: name, event: def.event, auto: def.auto === true, description: def.description }
  })
}

// 扁平阶段表：两条流程并起来去重，共用阶段带上 workflows 列表。
// 顺序按目录顺序（扫 PR / 核对排在出 PR 之后、合并之前），status 与文档都用它。
export const STAGES = (() => {
  const ids = Object.keys(WORKFLOWS).filter((id) => stagesOf(id).length)
  const out = []
  for (const name of Object.keys(STAGE_CATALOG)) {
    const used = ids.filter((id) => WORKFLOWS[id].stages.includes(name))
    if (!used.length) continue
    const def = STAGE_CATALOG[name]
    out.push({ stage: name, event: def.event, auto: def.auto === true, description: def.description, workflows: used })
  }
  return out
})()

export const EVENTS = Object.fromEntries(STAGES.map((s) => [s.stage, s.event]))

export function stageOf(event) {
  return STAGES.find((s) => s.event === event)?.stage ?? ""
}

// 这个事件属于哪几条流程：前者专属（如 issue.picked 只属于 own），
// 后者共用（pr.merged / issue.closed / …）——共用时靠 payload.workflow 区分。
export function workflowsOf(event) {
  return STAGES.find((s) => s.event === event)?.workflows ?? []
}

// 一条流程的全部事件，方便按流程筛历史。
export function eventsOf(workflow) {
  return stagesOf(workflow).map((s) => s.event)
}

// 走到这个阶段就算这条流程跑完了：关单即收口，后面的清理/归档不再占「在跑」的名额。
export const TERMINAL_STAGES = ["close"]

// Lifecycle：事件总线 + 钩子 + 历史（最近 N 条，排障用）。
// - hooks：配置/调用方给的额外动作，形如 { "pr.merged": async (payload) => {} }
// - adapters：每个适配器可实现 on(event, payload)，在 hooks 之后按注册顺序调用；
//   例如豆包 adapter 在 pr.merged 时归档执行会话，herdr adapter 在 pr.merged 时清工作区。
// - emit 的 payload 可以带 workflow（"own" / "review"）：共用阶段靠它标清是哪条流程，
//   专属阶段不给也会按事件推断。
// - runs：每条流程的实例（workflow + 工单/PR 号），跟着事件推进阶段；
//   「现在有几条接单流程在跑」就靠 active("own")，自动接单的容量按它算，不看零散的 watcher。
export class Lifecycle {
  constructor({ adapters = {}, hooks = {}, log = () => {}, historyLimit = 200, runLimit = 200 } = {}) {
    this.adapters = adapters
    this.hooks = hooks
    this.log = log
    this.historyLimit = historyLimit
    this.runLimit = runLimit
    this.history = []
    this.runs = new Map() // `${workflow}:${key}` → { workflow, key, stage, status, startedAt, updatedAt, pr }
  }

  stages() {
    return STAGES.map((s) => ({ ...s, workflows: [...s.workflows] }))
  }

  workflows() {
    return Object.values(WORKFLOWS).map((wf) => ({ ...wf, stages: stagesOf(wf.id) }))
  }

  // 一条流程实例：同一个 workflow + 同一个工单/PR 只有一个，重复事件只推进阶段。
  touchRun(workflow, key, { stage = "", status = "", pr = null, at = "" } = {}) {
    if (!workflow || !key) return null
    const rk = `${workflow}:${key}`
    const now = at || new Date().toISOString()
    let run = this.runs.get(rk)
    if (!run) {
      run = { workflow, key, stage: "", status: "running", startedAt: now, updatedAt: now, pr: null }
      this.runs.set(rk, run)
    }
    if (stage) {
      run.stage = stage
      // 本单在这个节点上的更新时间：控制台详情逐节点显示，便于看出卡在哪一步。
      run.stageAt = { ...(run.stageAt ?? {}), [stage]: now }
    }
    if (Number(pr)) run.pr = Number(pr)
    run.updatedAt = now
    if (status) run.status = status
    else if (TERMINAL_STAGES.includes(run.stage)) run.status = "done"
    if (run.status === "done" && !run.doneAt) run.doneAt = now
    this.trimRuns()
    return run
  }

  // 从账本恢复：服务重启后内存里的 runs 是空的，靠工单状态把在跑的流程补回来。
  // 状态映射：planned → pickup、working → dispatch、pr-open → pr-open；done 等终态不补。
  restore(issues = {}) {
    const stageOfIssue = {
      planned: "pickup",
      working: "dispatch",
      "pr-open": "pr-open",
    }
    for (const [key, it] of Object.entries(issues ?? {})) {
      const state = String(it?.state ?? "")
      const at = String(it?.updatedAt ?? "")
      const stage = stageOfIssue[state]
      if (stage) {
        this.touchRun("own", key, { stage, status: "running", pr: it?.pr ?? null, at })
        continue
      }
      // 已经合并关单的自有工单：补一条走到 close 的完成记录，
      // 否则控制台会显示成「未开始」，看起来像只走到一半。
      if (state === "done" && Number(it?.pr ?? 0)) {
        this.touchRun("own", key, { stage: "close", status: "done", pr: it.pr, at })
      }
    }
    return this.active("own")
  }

  // 这条流程实例走到过哪些节点：节点自清只清「真的跑过的节点」留下的东西。
  stagesReached(workflow, key) {
    const run = this.runs.get(`${workflow}:${key}`)
    return Object.keys(run?.stageAt ?? {})
  }

  // 按 PR 找流程实例：合并命令没带工单号时，靠它把 PR 接回自己的工单
  // （own 流程的 run key 就是工单键，pr 记录在 run 上）。
  runWithPr(repo, pr) {
    const number = Number(pr ?? 0)
    if (!number) return null
    for (const r of this.runs.values()) {
      if (r.workflow !== "own" || Number(r.pr) !== number) continue
      if (repo && !String(r.key ?? "").startsWith(`${repo}#`)) continue
      return r
    }
    return null
  }

  // 在跑的流程实例（默认只看 own；review 一般不占接单名额）。
  active(workflow = "") {
    return [...this.runs.values()]
      .filter((r) => r.status === "running" && (!workflow || r.workflow === workflow))
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  }

  // 给 status / 控制台看的实例列表（只留最近这一批）。
  runsList(limit = 20) {
    return [...this.runs.values()]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }

  trimRuns() {
    if (this.runs.size <= this.runLimit) return
    const finished = [...this.runs.values()]
      .filter((r) => r.status === "done")
      .sort((a, b) => String(a.doneAt ?? a.updatedAt).localeCompare(String(b.doneAt ?? b.updatedAt)))
    while (this.runs.size > this.runLimit && finished.length) {
      const r = finished.shift()
      this.runs.delete(`${r.workflow}:${r.key}`)
    }
  }

  async emit(event, payload = {}) {
    const owners = workflowsOf(event)
    const declared = String(payload.workflow ?? "")
    // 专属阶段：事件本身就说明了是哪条流程；共用阶段：认 payload 里点明的，点不明的记空。
    const workflow = declared || (owners.length === 1 ? owners[0] : "")
    if (declared && owners.length && !owners.includes(declared)) {
      this.log(`生命周期：事件 ${event} 不属于流程 ${declared}（属于 ${owners.join("/")}）`)
    }
    const stage = stageOf(event)
    const key = payload.issueKey ?? payload.key ?? ""
    const entry = {
      event,
      stage,
      workflow,
      at: new Date().toISOString(),
      key,
    }
    this.history.push(entry)
    if (this.history.length > this.historyLimit) this.history.shift()
    // 共用阶段（合并/关单）在流程实例上推进：靠 payload.workflow 落到对应那条流程。
    this.touchRun(workflow, key, { stage, pr: payload.pr ?? null })

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
