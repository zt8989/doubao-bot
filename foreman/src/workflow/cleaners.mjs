// 节点自清：每个 workflow 节点只清自己产生的东西。
//
// 为什么按节点拆：收口原先挤在「合并收尾」一处，任何一步缺失都会留下别人的产物——
// 没传 --issue 就没有关单节点，账本停在 pr-open；herdr 不在 PATH 时工作区清理静默跳过；
// 合并回执为空时 PR 永远挂在「待合并」。拆开之后每个节点只认自己的产物，漏一步也只影响
// 那一步，别的节点照样收尾。
//
//   workspace  建了 worktree/本地分支 → 合并后自己关 herdr、删 worktree、删分支
//   dispatch   派了执行会话并登记监听 → 收口时自己摘监听
//   pr-open    开了 PR → 合并后自己把 PR 从「待合并」摘成 merged（记录留着给 prWatch 去重）
//   merge      合并事实 → 自己写 mergeAsk、清合并队列
//   close      关单 + 摘 ready-for-agent 标签 + 工单账本 done
//   cleanup    兜底：清空壳 worktree dir、prune git 元数据、摘队列残留
//   archive    自己把执行会话归档
//
// 每个清理器都幂等：没有产物、产物已不在、远端已删，都算完成，只回一条 notes 说明。
import fs from "node:fs"
import path from "node:path"
import { git } from "../gitx.mjs"
import { expandHome } from "../util.mjs"

// 合上之后要摘掉的标签：留着会把已完成的单继续喂给接单查询（虽然 closed 不会被捞）。
export const READY_LABEL = "ready-for-agent"

// 节点名前缀统一写进 notes，排障时一眼看出是哪一步做的/没做的。
function at(stage, msg) {
  return `${stage} 节点：${msg}`
}

export const NODE_TEARDOWN = {
  // workspace：它建的 worktree 与本地分支，只有它自己清得掉（herdr 工作区按 checkout_path 匹配）。
  async workspace({ book, issueKey, repo, cfg = {}, workspace, log = () => {} }) {
    const rec = issueKey ? book.issue(issueKey) : null
    if (!rec?.worktree && !rec?.branch) {
      return { notes: [`账本里没有 worktree 记录，跳过本地清理`] }
    }
    const repoDir = (cfg.repos ?? []).find((r) => r.repo === repo)?.dir ?? ""
    if (!workspace?.cleanup || !repoDir) {
      return { notes: [at("workspace", "没有仓库目录或工作区适配器，跳过本地清理")] }
    }
    try {
      const out = await workspace.cleanup({
        repoDir,
        worktree: rec.worktree ?? "",
        branch: rec.branch ?? "",
      })
      return { notes: out?.notes ?? [] }
    } catch (e) {
      return { notes: [at("workspace", `清理失败：${String(e?.message ?? e).slice(0, 160)}`)] }
    }
  },

  // dispatch：它派的执行会话登记的监听，由它自己摘；别的单的监听不动。
  // 执行会话在 sessions 里的记录一并删掉——只摘 watch 的话，服务重启会按 sessions
  // 把这条已完结会话重新登记回来，每轮还得切窗口去读它的状态。
  async dispatch({ book, issueKey, repo, issueNo }) {
    let count = 0
    while (issueKey && book.delWatchIssue(issueKey)) count++
    const slug = String(repo ?? "").split("/").pop() ?? ""
    const sessionName = slug && issueNo ? `foreman-${slug}-${issueNo}` : ""
    const droppedSession = sessionName && typeof book.delSession === "function" ? book.delSession(sessionName) : false
    const notes = []
    if (count) notes.push(`摘掉 ${count} 条执行会话监听`)
    if (droppedSession) notes.push(`收掉执行会话记录 ${sessionName}`)
    return { notes }
  },

  // pr-open：它开出的 PR 合并后要落成 merged，但记录保留（删了会被 prWatch 当新 PR 再通知）。
  async "pr-open"({ book, repo, pr, prUrl = "" }) {
    const number = Number(pr ?? 0)
    if (!number) return { notes: [] }
    book.markPrSeen(`${repo}#${number}`, {
      repo,
      number,
      url: prUrl,
      merged: true,
      skipped: "merged",
      mergeError: "",
    })
    return { notes: [] }
  },

  // merge：合并事实落账；每张 PR 只合一次的幂等也记在这里。
  async merge({ book, key, repo, pr, prUrl = "" }) {
    const number = Number(pr ?? 0)
    if (!number) return { notes: [] }
    book.markMergeAsked(key, { pr: number, url: prUrl, status: "merged", error: "" })
    try {
      book.dropMerge(key)
    } catch {}
    return { notes: [] }
  },

  // close：关单 + 摘 ready-for-agent + 工单账本 done。没有工单号时明确说一句，不静默。
  async close({ tracker, book, issueKey, repo, issueNo, pr, prUrl = "" }) {
    const number = Number(issueNo ?? 0)
    if (!number || !issueKey) return { notes: [at("close", "没有关联工单号，关单与摘标签跳过")] }
    const notes = []
    try {
      await tracker.closeIssue(repo, number)
    } catch (e) {
      const msg = String(e?.message ?? e ?? "")
      // 已经是关闭状态同样算收尾完成，不算失败。
      if (/已经关闭|无需重复关闭/.test(msg)) notes.push(`工单 #${number} 早已关闭`)
      else notes.push(`关单 #${number} 失败：${msg.slice(0, 160)}`)
    }
    // 标签是 close 节点的产物：单都关了，接单标签必须摘掉，不然控制台/查询里还挂着。
    try {
      if (typeof tracker.editLabels === "function") {
        const out = await tracker.editLabels(repo, number, { remove: READY_LABEL })
        if (out?.changed) notes.push(`摘掉标签 ${READY_LABEL}`)
      }
    } catch (e) {
      notes.push(`摘标签失败：${String(e?.message ?? e).slice(0, 160)}`)
    }
    book.setIssue(issueKey, {
      state: "done",
      pr: Number(pr ?? 0) || undefined,
      prUrl: prUrl || undefined,
      mergeError: "",
    })
    return { notes }
  },

  // cleanup：兜底清扫，只清「没有节点认领」的残留——空壳 worktree 目录、git 的 worktree 元数据、
  // 账本里已合并还留在队列里的条目。真正的 worktree/分支归 workspace 节点，这里不重复删。
  async cleanup({ book, key, repo, cfg = {} }) {
    const notes = []
    try {
      book.dropMerge(key)
    } catch {}
    const repoDir = (cfg.repos ?? []).find((r) => r.repo === repo)?.dir ?? ""
    if (!repoDir) return { notes }
    const expanded = expandHome(repoDir)
    if (!fs.existsSync(expanded)) return { notes }
    try {
      await git(["worktree", "prune"], { cwd: expanded, timeout: 60000 })
    } catch (e) {
      notes.push(at("cleanup", `git worktree prune 失败：${String(e?.message ?? e).slice(0, 120)}`))
    }
    // 上一轮删掉 worktree 后可能留下空的 <worktrees>/<repo> 目录，删掉才算清干净。
    // 只认配置里写明的 worktreeDir，避免测试/脚本误删用户目录。
    if (!cfg.worktreeDir) return { notes }
    const wtRoot = expandHome(cfg.worktreeDir)
    const slug = String(repo).split("/").pop() ?? ""
    const dir = path.join(wtRoot, slug)
    try {
      if (slug && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
        notes.push(at("cleanup", `删掉空目录 ${dir}`))
      }
    } catch (e) {
      notes.push(at("cleanup", `空目录清理失败：${String(e?.message ?? e).slice(0, 120)}`))
    }
    return { notes }
  },

  // archive：执行会话是 archive 节点收的（不是合并时顺手归档），关掉可配置。
  async archive({ session, cfg = {}, target = "", log = () => {} }) {
    if (cfg.workflow?.archiveAfterMerge === false) return { notes: [at("archive", "已关闭，跳过归档")] }
    if (!target) return { notes: [] }
    if (!session?.archive) return { notes: [at("archive", "没有会话适配器，跳过归档")] }
    try {
      await session.archive(target)
      log(`archive 节点：执行会话已归档 ${target}`)
      return { notes: [`执行会话已归档：${target}`] }
    } catch (e) {
      return { notes: [at("archive", `归档失败：${String(e?.message ?? e).slice(0, 160)}`)] }
    }
  },
}

// 一个节点清自己：暂停的节点只记一句、不动作（节点级暂停只管它自己的自动动作）。
export async function runNodeCleanup(stage, ctx, { paused = false } = {}) {
  const fn = NODE_TEARDOWN[stage]
  if (typeof fn !== "function") return { stage, notes: [] }
  if (paused) return { stage, notes: [at(stage, "已暂停，跳过它自己的清理")] }
  const out = await fn(ctx)
  return { stage, notes: out?.notes ?? [] }
}

// 由 PR 反查工单：先看流程实例（own 流程的 run key 就是工单键，且 pr 落在 run 上），
// 再看账本里 pr 对得上的工单记录。合并命令没给 --issue 时靠这条把关单节点接上。
export function resolveIssueKey({ runs = [], book = null, repo = "", pr = 0 } = {}) {
  const number = Number(pr ?? 0)
  if (!number) return ""
  for (const r of runs) {
    if (r?.workflow !== "own") continue
    if (Number(r?.pr) !== number) continue
    if (repo && !String(r.key ?? "").startsWith(`${repo}#`)) continue
    return String(r.key)
  }
  const issues = book?.issues ?? {}
  for (const [key, it] of Object.entries(issues)) {
    if (Number(it?.pr) !== number) continue
    if (repo && !key.startsWith(`${repo}#`)) continue
    return key
  }
  return ""
}
