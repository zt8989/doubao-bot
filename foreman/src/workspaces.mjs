// 一工程一工作区：一张工单可以同时改多个工程，每个工程各自一个 worktree、一条同名分支。
//
// 为什么按工程拆：工单经常跨仓（比如 harness 的 web 与后管 apps/admin 的镜像页）。
// 一张单只建一个 worktree 时，执行会话在「只在这个工作区里改」的边界前只能交 need_decision。
// 这里的口径是：工单牵涉几个工程就建几个工作区，一个工程一个、互不共用；表外的工程由
// 执行会话用 `foreman ws add` 现开（幂等），不许跨目录、不许在主 checkout 里改。
import path from "node:path"

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// 工单里提到哪些工程：先认工单所在仓库，再扫标题+正文里出现的其它工程标识。
// 只在本产品内扫（产品 = 一套自己的项目群），避免把别的产品的仓库拉进来。
export function reposForIssue(issue = {}, repos = [], primary = null, { maxExtra = 3 } = {}) {
  const text = `${issue.title ?? ""}\n${issue.body ?? ""}`
  const out = []
  if (primary) out.push(primary)
  const sameProduct = (repos ?? []).filter((r) => !primary?.product || r.product === primary.product)
  for (const r of sameProduct) {
    if (primary && r.repo === primary.repo) continue
    if (out.length >= 1 + maxExtra) break
    if (!mentionsRepo(text, r)) continue
    out.push(r)
  }
  return out
}

// 三种写法都算点到这个工程：owner/name、<仓库名>/<子路径>、单独的仓库名。
// 仓库名太短（<4 字）只认前两种，避免 "web"、"api" 这种词误命中。
export function mentionsRepo(text, repoCfg = {}) {
  const t = String(text ?? "")
  if (!t) return false
  const full = String(repoCfg.repo ?? "").trim()
  if (full && new RegExp(`${escapeRe(full)}(?![A-Za-z0-9._/-])`, "i").test(t)) return true
  const name = String(repoCfg.name ?? full.split("/")[1] ?? "").trim()
  if (!name) return false
  if (new RegExp(`${escapeRe(name)}/[A-Za-z0-9._-]`, "i").test(t)) return true
  if (name.length < 4) return false
  return new RegExp(`(?<![A-Za-z0-9._/-])${escapeRe(name)}(?![A-Za-z0-9._-])`, "i").test(t)
}

// 一个工程的工作区：<worktreeDir>/<工程名>/<分支里的 / 换成 ->。
export function workspacePath(worktreeDir, repoCfg = {}, branch = "") {
  const name = String(repoCfg?.name || repoCfg?.repo?.split("/").pop() || "repo")
  return path.join(String(worktreeDir), name, String(branch).replace(/\//g, "-"))
}

// 账本里这条工单对某个工程的工作区记录。
export function findWorkspace(rec = {}, repo = "") {
  const list = Array.isArray(rec?.workspaces) ? rec.workspaces : []
  const hit = list.find((w) => w?.repo === repo)
  if (hit) return hit
  // 老账本只有单工作区字段：只认主仓库，别的工程一律当没有。
  if (!list.length && (rec?.repo === repo || (!rec?.repo && rec?.worktree))) {
    return { repo: rec?.repo || repo, branch: rec.branch ?? "", worktree: rec.worktree ?? "" }
  }
  return null
}

// 记一条工作区：同工程覆盖，别的工程保留。
export function mergeWorkspace(list = [], entry = {}) {
  const out = Array.isArray(list) ? [...list] : []
  if (!entry?.repo) return out
  const i = out.findIndex((w) => w?.repo === entry.repo)
  if (i >= 0) out[i] = { ...out[i], ...entry }
  else out.push(entry)
  return out
}

// 多 PR 记账：一个工程一条（同工程覆盖），别的工程保留。
export function upsertPr(list = [], entry = {}) {
  const out = Array.isArray(list) ? [...list] : []
  if (!entry?.repo) return out
  const i = out.findIndex((p) => p?.repo === entry.repo)
  if (i >= 0) out[i] = { ...out[i], ...entry }
  else out.push(entry)
  return out
}

// 这条工单在账本里有哪些工程的 PR（老账本只有单 PR 字段时补一条）。
export function issuePrs(rec = {}, repo = "") {
  const list = Array.isArray(rec?.prs) ? rec.prs.filter((p) => Number(p?.pr) > 0) : []
  if (list.length) return list
  const number = Number(rec?.pr ?? 0)
  if (number && (repo || rec?.repo)) {
    return [{ repo: rec?.repo || repo, branch: rec?.branch ?? "", pr: number, prUrl: rec?.prUrl ?? "" }]
  }
  return []
}
