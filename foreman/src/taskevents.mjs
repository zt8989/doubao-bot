import { routerOnce } from "./core/router.mjs"
import { Book } from "./book.mjs"

// 任务 → 所属 Agent 的唯一归属规则。优先使用工单绑定的编排，兼容补派监听与旧账本。
export function taskOwner(book, watcher = {}) {
  const issue = watcher.issueKey ? book.issue(watcher.issueKey) : null
  const session = watcher.name ? book.session(watcher.name) : null
  const router = book.data?.router?.convId ?? book.data?.inspector?.convId ?? ""
  const candidates = [
    issue?.orchestrator,
    watcher.parent,
    session?.parent,
    watcher.notifyTo,
    book.data?.orchestrator?.convId,
    router,
  ]
  const owner = candidates.map((v) => String(v ?? "").trim()).find((v) => v && v !== String(watcher.target ?? ""))
  return { owner: owner ?? "", viaInspector: Boolean(owner && owner === router && !issue?.orchestrator && !watcher.parent && !session?.parent && !watcher.notifyTo) }
}

export function taskUpdateText({ watcher = {}, phase = "", owner = "", finalText = "" } = {}) {
  const lines = [
    "【Foreman · 工作会话状态变化】",
    `任务：${watcher.name || watcher.target || "（未命名）"}${watcher.target ? `（${watcher.target}）` : ""}`,
    `工单：${watcher.issueKey || "（未绑定）"}`,
    `状态：${phase}`,
    `归属 Agent：${owner}`,
    "",
    "这是任务状态与最终回复的可靠投递，不是业务结论。请由你结合提交、diff、测试和工单决定后续动作；是否开 PR、续跑和收尾均由编排智能体判断，Foreman 不自动补充业务决定。",
  ]
  if (["finished", "settled"].includes(phase)) {
    lines.push("", "最终回复原文：", String(finalText ?? "").trim() || "（会话没有可读取的最终回复）")
  }
  return lines.join("\n")
}

// 只入持久 Inbox。调用方不得在 enqueue 成功后提前 markIdle/markNotified；这些账本由 Worker 送达后推进。
// running 只是会话还在跑，不是业务状态变化：一律不投递，编排只收 finished/settled/gone。
export function enqueueTaskUpdate(ctx, { watcher, phase, fingerprint = "", finalText = "", observedAt = new Date() } = {}) {
  if (String(phase ?? "") === "running") return { ok: false, reason: "running-not-notified" }
  if (!ctx.inbox) return { ok: false, reason: "no-inbox" }
  const book = ctx.book ?? ctx.bookFactory?.()
  if (!book) throw new Error("task.update 缺少账本")
  const { owner, viaInspector: viaRouter } = taskOwner(book, watcher)
  if (!owner) return { ok: false, reason: "no-owner" }
  const at = observedAt instanceof Date ? observedAt : new Date(observedAt)
  const stamp = at.toISOString()
  const text = taskUpdateText({ watcher, phase, owner, finalText })
  const outcome = ctx.inbox.enqueue({
    kind: "task.update",
    text,
    payload: {
      taskId: String(watcher.target ?? ""),
      taskName: String(watcher.name ?? watcher.target ?? ""),
      issueKey: String(watcher.issueKey ?? ""),
      repo: String(watcher.repo ?? ""),
      number: watcher.number ?? null,
      owner,
      viaRouter,
      viaInspector: viaRouter, // 旧事件字段兼容
      phase,
      fingerprint,
      finalText: String(finalText ?? ""),
      observedAt: stamp,
    },
    dedupeKey: `task:${watcher.target}:${phase}:${fingerprint || stamp}`,
    coalesceKey: `task:${watcher.target}:update`,
  }, at)
  return { ...outcome, ok: true, owner, text }
}

const SESSION_GONE = /侧边栏里没有任务/

async function routeTaskUpdate(ctx, event, { fallbackFrom = "" } = {}) {
  const text = fallbackFrom
    ? [
        "【Foreman · 任务更新路由兜底】",
        `原归属 Agent ${fallbackFrom} 不在 dws 侧边栏，无法 queue。请接管以下任务更新，核对原编排是否已归档或失联，再决定重派、续跑或其他后续动作。`,
        String(event.text ?? ""),
      ].join("\n\n")
    : event.text
  const delivered = await routerOnce(ctx, { force: true, scheduled: false, notices: [text] })
  if (!delivered?.ok || delivered.skipped) {
    throw new Error(delivered?.error || `router agent 未接收 task.update：${delivered?.skipped || "unknown"}`)
  }
  return delivered
}

// Worker 的唯一 task.update handler：优先 queue 给所属 Agent；原会话已从侧边栏消失时兜底交路由。
export async function deliverTaskUpdate(ctx, event) {
  const p = event.payload ?? {}
  const target = String(p.owner ?? "").trim()
  if (!target) throw new Error("task.update 缺少归属 Agent")
  if (target === String(p.taskId ?? "")) throw new Error("task.update 不能投递给被监听任务自己")
  let deliveredTarget = target
  let fallback = false
  if (p.viaRouter || p.viaInspector) {
    const delivered = await routeTaskUpdate(ctx, event)
    deliveredTarget = delivered.convId || target
  } else {
    if (typeof ctx.dws?.queue !== "function") throw new Error("dws.queue 不可用")
    try {
      await ctx.dws.queue(target, event.text)
    } catch (error) {
      if (!SESSION_GONE.test(String(error?.message ?? error))) throw error
      const delivered = await routeTaskUpdate(ctx, event, { fallbackFrom: target })
      deliveredTarget = delivered.convId || target
      fallback = true
      ctx.log?.(`task.update 原归属会话不在侧边栏，已兜底投递 router agent：${target}`)
    }
  }
  const book = ctx.book ?? ctx.bookFactory?.() ?? new Book(ctx.cfg.stateFile)
  if (book) {
    book.clearIdle(p.taskId)
    // gone 本身就是持续状态的去重标记；送达后不能清掉，否则下一轮 poll 会重新入队。
    // 会话重新出现或恢复 running 时，仍由 pollOnce 负责清 gone。
    if (p.phase !== "gone") book.clearGone(p.taskId)
    if (typeof book.markSteer === "function") {
      book.markSteer(deliveredTarget, { kind: `task:${p.phase || "update"}`, chars: String(event.text ?? "").length })
    }
    book.markTaskObserved(p.taskId, p.phase, { fingerprint: p.fingerprint })
    if (["finished", "settled"].includes(p.phase)) {
      book.markNotified(p.taskId, p.fingerprint, { phase: p.phase, chars: String(p.finalText ?? "").length })
      book.markIdle(p.taskId, { fingerprint: p.fingerprint })
    }
  }
  return { ok: true, target: deliveredTarget, originalTarget: target, fallback, taskId: p.taskId, phase: p.phase }
}
