// workflow 节点的运行状态：暂停/继续 + 累计执行次数。
//
// 节点 = 生命周期里的一个阶段（pickup / dispatch / scan / review / merge / close / cleanup / archive / notify…）。
// 暂停是**节点级**的：只停这一个节点自己的自动动作，不停止整条 workflow，后面的节点照跑。
// 统计是**累计**的：auto 节点每执行一次 +1，只增不减（不因为暂停、重启、换天而归零）。
//
// 落盘在账本 state.json 的 workflow 键下：{ paused: ["pickup"], counts: { pickup: { count, lastAt, lastResult } } }
import { Book } from "../book.mjs"
import { nowIso } from "../util.mjs"

export function nodeBook(stateFile) {
  return new Book(stateFile)
}

function bag(book) {
  const w = book.data.workflow ?? (book.data.workflow = {})
  if (!Array.isArray(w.paused)) w.paused = []
  if (!w.counts || typeof w.counts !== "object") w.counts = {}
  return w
}

export function pausedNodes(stateFile) {
  return [...bag(new Book(stateFile)).paused]
}

export function isPaused(stateFile, stage) {
  return bag(new Book(stateFile)).paused.includes(String(stage))
}

// 暂停/继续一个节点；返回最新状态。传 paused 时按给定值，不传就切换。
export function setNodePaused(stateFile, stage, paused, { by = "" } = {}) {
  const book = new Book(stateFile)
  const w = bag(book)
  const s = String(stage)
  const on = paused === undefined ? !w.paused.includes(s) : !!paused
  w.paused = on ? [...new Set([...w.paused, s])] : w.paused.filter((x) => x !== s)
  w.at = nowIso()
  if (by) w.by = by
  book.save()
  return { stage: s, paused: on, pausedNodes: [...w.paused] }
}

// 节点跑了一次：累计 +1（只增不减），顺手记最后一次的说明。
export function bumpNode(stateFile, stage, { detail = "", at = "" } = {}) {
  const book = new Book(stateFile)
  const w = bag(book)
  const s = String(stage)
  const prev = w.counts[s] ?? { count: 0 }
  w.counts[s] = {
    count: Number(prev.count ?? 0) + 1,
    lastAt: at || nowIso(),
    firstAt: prev.firstAt || at || nowIso(),
    detail: String(detail ?? "").slice(0, 200),
  }
  book.save()
  return w.counts[s]
}

export function nodeCounts(stateFile) {
  return { ...bag(new Book(stateFile)).counts }
}
