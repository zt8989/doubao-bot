// Gitea REST 业务封装：工单、合并请求、标签、里程碑、分支、附件。
// 所有函数只做两件事：拼 REST 请求、把返回结构抹平成 CLI/foreman 一直用的字段。
import fs from "node:fs"
import path from "node:path"
import { request, loadGiteaSettings, GiteaApiError } from "./client.mjs"

const PAGE_LIMIT = 50

export function repoParts(repo) {
  const s = String(repo ?? "").replace(/^\/+|\/+$/g, "")
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s)
  if (!m) throw new GiteaApiError(`repo 必须是 owner/name 格式，当前: "${repo}"`, { code: "argument_error" })
  return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` }
}

const enc = (v) => encodeURIComponent(String(v))

function context(opts) {
  const settings = opts?.settings ?? loadGiteaSettings()
  return { settings, fetchImpl: opts?.fetchImpl }
}

function api(pathname, options = {}, opts = {}) {
  return request(pathname, { ...options, ...context(opts) })
}

// ---- 映射 ----

const userName = (u) => u?.login ?? u?.username ?? u?.name ?? ""
const labelName = (l) => (typeof l === "string" ? l : l?.name ?? "")
const labelObj = (l) => ({
  id: Number(l?.id) || null,
  name: l?.name ?? null,
  color: l?.color ?? null,
  description: l?.description ?? null,
})

export function mapIssue(issue, { repo = "" } = {}) {
  if (!issue) return null
  return {
    number: Number(issue.number) || null,
    id: Number(issue.id) || null,
    title: issue.title ?? "",
    state: issue.state ?? "",
    body: issue.body ?? "",
    bodyMd: issue.body ?? "",
    author: userName(issue.user) || issue.original_author || "",
    assignees: (issue.assignees ?? []).map(userName).filter(Boolean),
    labels: (issue.labels ?? []).map(labelName).filter(Boolean),
    labelObjects: (issue.labels ?? []).map(labelObj),
    milestone: issue.milestone
      ? { id: Number(issue.milestone.id) || null, name: issue.milestone.title ?? null }
      : null,
    dueDate: issue.due_date ?? null,
    ref: issue.ref ?? "",
    commentsCount: Number(issue.comments) || 0,
    createdAt: issue.created_at ?? "",
    updatedAt: issue.updated_at ?? "",
    url: issue.html_url ?? (repo ? `${loadGiteaSettings().baseUrl}/${repo}/issues/${issue.number}` : ""),
    pullRequest: issue.pull_request ? { merged: Boolean(issue.pull_request.merged), htmlUrl: issue.pull_request.html_url ?? "" } : null,
    projects: (issue.projects ?? []).map((p) => mapProject(p, { owner: repo.split("/")[0] })),
  }
}

export function mapProject(p, { owner = "", scope = "repo" } = {}) {
  if (!p) return null
  return {
    id: Number(p.id) || null,
    title: p.title ?? "",
    scope,
    state: p.state ?? "",
    description: p.description ?? "",
    cardType: p.card_type ?? "",
    closedAt: p.closed_at ?? "",
    createdAt: p.created_at ?? "",
    updatedAt: p.updated_at ?? "",
    url: owner && p.id ? `${loadGiteaSettings().baseUrl}/${owner}/projects/${p.id}` : "",
  }
}

export function mapComment(c, { repo = "" } = {}) {
  return {
    id: Number(c?.id) || null,
    author: userName(c?.user) || c?.original_author || "",
    authoredAt: c?.created_at ?? "",
    body: c?.body ?? "",
    bodyMd: c?.body ?? "",
    url: c?.html_url ?? "",
  }
}

export function mapPull(pr, { repo = "" } = {}) {
  if (!pr) return null
  const base = pr.base?.label ?? pr.base?.ref ?? null
  const head = pr.head?.label ?? pr.head?.ref ?? null
  const headSha = pr.head?.sha ?? ""
  const mergeBase = pr.merge_base ?? ""
  const merged = Boolean(pr.merged) || pr.state === "merged"
  const state = merged ? "merged" : (pr.state ?? "")
  let mergeNote = null
  if (merged) mergeNote = "合并请求已合并"
  else if (pr.state === "closed") mergeNote = "合并请求已关闭，无法合并"
  else if (mergeBase && headSha && mergeBase === headSha) mergeNote = "此分支已经包含在目标分支中，没有什么可以合并"
  else if (pr.mergeable === false) mergeNote = "当前不可自动合并：可能存在冲突、分支已包含或缺少合并权限"
  return {
    number: Number(pr.number) || null,
    title: pr.title ?? "",
    state,
    merged,
    mergeable: pr.mergeable ?? null,
    mergeNote,
    author: userName(pr.user) || "",
    head,
    base,
    headSha,
    baseSha: pr.base?.sha ?? "",
    mergeBase,
    commits: Number(pr.commits) || null,
    filesCount: Number(pr.changed_files) || 0,
    additions: Number(pr.additions) || 0,
    deletions: Number(pr.deletions) || 0,
    body: pr.body ?? "",
    bodyMd: pr.body ?? "",
    draft: Boolean(pr.draft),
    createdAt: pr.created_at ?? "",
    updatedAt: pr.updated_at ?? "",
    mergedAt: pr.merged_at ?? "",
    url: pr.html_url ?? (repo ? `${loadGiteaSettings().baseUrl}/${repo}/pulls/${pr.number}` : ""),
    labels: (pr.labels ?? []).map(labelName).filter(Boolean),
    assignees: (pr.assignees ?? []).map(userName).filter(Boolean),
    projects: (pr.projects ?? []).map((p) => mapProject(p, { owner: repo.split("/")[0] })),
  }
}

export function mapMilestone(m) {
  if (!m) return null
  const open = Number(m.open_issues) || 0
  const closed = Number(m.closed_issues) || 0
  const total = open + closed
  return {
    id: Number(m.id) || null,
    name: m.title ?? "",
    title: m.title ?? "",
    state: m.state ?? "",
    description: m.description ?? "",
    percent: total ? Math.round((closed / total) * 100) : 0,
    openCount: open,
    closedCount: closed,
    due: m.due_on ? String(m.due_on).slice(0, 10) : null,
    createdAt: m.created_at ?? "",
    updatedAt: m.updated_at ?? "",
  }
}

export function mapLabel(l, scope = "repo") {
  return {
    id: Number(l?.id) || null,
    scope,
    name: l?.name ?? null,
    color: l?.color ? String(l.color).startsWith("#") ? String(l.color) : `#${l.color}` : null,
    description: l?.description ?? null,
    issuesCount: Number(l?.issues_count) || 0,
    url: l?.url ?? "",
  }
}

export function mapRepo(r) {
  return {
    id: Number(r?.id) || null,
    repo: r?.full_name ?? "",
    name: r?.name ?? "",
    owner: r?.owner?.login ?? "",
    description: r?.description ?? "",
    private: Boolean(r?.private),
    defaultBranch: r?.default_branch ?? "",
    htmlUrl: r?.html_url ?? "",
    updatedAt: r?.updated_at ?? "",
  }
}

async function pagedList(pathname, { query = {}, opts = {}, limit = PAGE_LIMIT, maxPages = 50 } = {}) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const list = await api(pathname, { query: { ...query, page, limit } }, opts)
    if (!Array.isArray(list) || !list.length) break
    out.push(...list)
    if (list.length < limit) break
  }
  return out
}

// ---- 读 ----

export async function listIssues(repo, { state = "open", labels = "", q = "", type = "issues", page = 1, limit = PAGE_LIMIT, assignee = "", milestone = "", opts = {} } = {}) {
  const r = repoParts(repo)
  const query = { state, q, type, page, limit }
  // REST 的 labels 参数只认名字。调用方（foreman pickup）配置的是 id，所以先把 id 翻成名字，
  // 再在结果里按 id 精确过滤——否则服务端会把不匹配的名字当成“不过滤”，静默捞全量。
  let labelIds = []
  let labelNames = []
  if (labels) {
    for (const raw of String(labels).split(",").map((v) => v.trim()).filter(Boolean)) {
      if (/^\d+$/.test(raw)) labelIds.push(Number(raw))
      else labelNames.push(raw)
    }
    if (labelIds.length) {
      const all = await listLabels({ repo: r.full, opts })
      const byId = new Map(all.map((l) => [l.id, l.name]))
      const missing = labelIds.filter((id) => !byId.has(id))
      if (missing.length) {
        throw new GiteaApiError(`仓库 ${r.full} 找不到标签 id ${missing.join(", ")}`, { code: "not_found" })
      }
      for (const id of labelIds) labelNames.push(byId.get(id))
    }
    query.labels = labelNames.join(",")
  }
  if (milestone && !/^(none)$/i.test(milestone)) query.milestones = milestone
  if (assignee && !/^(none|any)$/i.test(assignee)) query.assigned_by = assignee
  let list = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues`, { query }, opts)
  if (!Array.isArray(list)) list = []
  if (labelIds.length) list = list.filter((i) => (i.labels ?? []).some((l) => labelIds.includes(Number(l.id))))
  if (/^none$/i.test(assignee)) list = list.filter((i) => (i.assignees ?? []).length === 0)
  if (/^any$/i.test(assignee)) list = list.filter((i) => (i.assignees ?? []).length > 0)
  if (/^none$/i.test(milestone)) list = list.filter((i) => !i.milestone)
  return list.map((i) => {
    const { body, bodyMd, raw, ...rest } = mapIssue(i, { repo: r.full })
    return rest
  })
}

export async function viewIssue(repo, number, { opts = {}, withComments = true } = {}) {
  const r = repoParts(repo)
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {}, opts)
  const mapped = mapIssue(issue, { repo: r.full })
  if (withComments) {
    const comments = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/comments`, { opts })
    mapped.comments = comments.map((c) => mapComment(c, { repo: r.full }))
  }
  mapped.raw = issue
  return mapped
}

export async function listIssueComments(repo, number, { opts = {} } = {}) {
  const r = repoParts(repo)
  const comments = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/comments`, { opts })
  return comments.map((c) => mapComment(c, { repo: r.full }))
}

export async function listPulls(repo, { state = "open", page = 1, limit = PAGE_LIMIT, sort = "", opts = {} } = {}) {
  const r = repoParts(repo)
  const query = { state, page, limit }
  if (sort) query.sort = sort
  const list = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls`, { query }, opts)
  return (Array.isArray(list) ? list : []).map((p) => {
    const { body, bodyMd, raw, ...rest } = mapPull(p, { repo: r.full })
    return { ...rest, repo: r.full, startDate: p.created_at ?? "" }
  })
}

export async function viewPull(repo, number, { files = false, opts = {} } = {}) {
  const r = repoParts(repo)
  const pr = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}`, {}, opts)
  const mapped = mapPull(pr, { repo: r.full })
  const comments = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/comments`, { opts })
  mapped.comments = comments.map((c) => mapComment(c, { repo: r.full }))
  try {
    const commits = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}/commits`, { opts, maxPages: 4 })
    mapped.commits = commits.length
  } catch {}
  if (files) {
    const list = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}/files`, { opts })
    mapped.files = list.map((f) => ({
      name: f.filename ?? "",
      status: f.status ?? "",
      added: Number(f.additions) || 0,
      removed: Number(f.deletions) || 0,
    }))
  }
  mapped.raw = pr
  return mapped
}

// 项目（Projects）：仓库级与组织级是两套列表，创建工单时两边的项目都能挂。
export async function listProjects(repo, { state = "open", page = 1, limit = PAGE_LIMIT, opts = {} } = {}) {
  const r = repoParts(repo)
  const query = new URLSearchParams({ state, page: String(page), limit: String(limit) }).toString()
  const rows = (await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/projects?${query}`, {}, opts)) ?? []
  const out = rows.map((p) => mapProject(p, { owner: r.owner, scope: "repo" }))
  try {
    const orgRows = (await api(`/api/v1/orgs/${enc(r.owner)}/projects?${query}`, {}, opts)) ?? []
    for (const p of orgRows) {
      if (!out.some((x) => x.id === Number(p?.id))) out.push(mapProject(p, { owner: r.owner, scope: "org" }))
    }
  } catch (e) {
    // owner 不是组织时该接口 404，忽略；鉴权/网络错误照常抛。
    if (e?.code !== "not_found" && e?.status !== 404) throw e
  }
  return out
}

export async function resolveProjectIds(repo, values, { opts = {} } = {}) {
  const wanted = (Array.isArray(values) ? values : String(values ?? "").split(","))
    .map((v) => String(v).trim())
    .filter(Boolean)
  if (!wanted.length) return []
  const projects = await listProjects(repo, { state: "all", limit: 100, opts })
  const ids = []
  for (const w of wanted) {
    const hit = projects.find((p) => String(p.id) === w) ?? projects.find((p) => p.title === w)
    if (!hit) {
      throw new GiteaApiError(
        `找不到项目 "${w}"，可选: ${projects.map((p) => `${p.title}=${p.id}`).join(", ") || "（仓库/组织下还没有项目）"}`,
        { code: "argument_error" },
      )
    }
    if (!ids.includes(hit.id)) ids.push(hit.id)
  }
  return ids
}

// 工单与合并请求共用：PATCH /issues/{n} 的 projects 字段会整体替换已有项目集合。
export async function setIssueProjects(repo, number, projectIds, { opts = {} } = {}) {
  const r = repoParts(repo)
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {
    method: "PATCH",
    body: { projects: (projectIds ?? []).map(Number) },
  }, opts)
  return mapIssue(issue, { repo: r.full })
}

export async function listLabels({ repo = "", org = "", opts = {} } = {}) {
  if (!repo && !org) throw new GiteaApiError("repo 和 org 至少提供一个", { code: "argument_error" })
  if (repo && org) throw new GiteaApiError("repo 和 org 只能提供一个", { code: "argument_error" })
  if (repo) {
    const r = repoParts(repo)
    const list = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/labels`, { opts })
    const own = list.map((l) => mapLabel(l, "repo"))
    // 组织级标签（needs-triage 这类）不在 /repos/{owner}/{repo}/labels 里，
    // 但工单上用的就是它们；按名字查 id 时必须合并进来，否则改标签会报找不到。
    try {
      const orgList = await pagedList(`/api/v1/orgs/${enc(r.owner)}/labels`, { opts })
      const seen = new Set(own.map((l) => l.name))
      for (const l of orgList) {
        const mapped = mapLabel(l, "org")
        if (!seen.has(mapped.name)) own.push(mapped)
      }
    } catch {}
    return own
  }
  const list = await pagedList(`/api/v1/orgs/${enc(org)}/labels`, { opts })
  return list.map((l) => mapLabel(l, "org"))
}

export async function listMilestones(repo, { state = "open", query = "", page = 1, limit = PAGE_LIMIT, all = false, opts = {} } = {}) {
  const r = repoParts(repo)
  if (all) {
    const list = await pagedList(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/milestones`, { query: { state: "all", name: query }, opts })
    return list.map(mapMilestone)
  }
  const list = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/milestones`, {
    query: { state, name: query || undefined, page, limit },
  }, opts)
  return (Array.isArray(list) ? list : []).map(mapMilestone)
}

export async function getRepo(repo, { opts = {} } = {}) {
  const r = repoParts(repo)
  const data = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}`, {}, opts)
  return { ...mapRepo(data), raw: data }
}

export async function searchRepos(q = "", { page = 1, limit = PAGE_LIMIT, opts = {} } = {}) {
  const data = await api("/api/v1/repos/search", { query: { q, page, limit } }, opts)
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
  return list.map(mapRepo)
}

export async function listMyRepos({ page = 1, limit = PAGE_LIMIT, opts = {} } = {}) {
  const list = await api("/api/v1/user/repos", { query: { page, limit } }, opts)
  return (Array.isArray(list) ? list : []).map(mapRepo)
}

export async function searchIssuesAcross({ q = "", state = "open", type = "issues", page = 1, limit = PAGE_LIMIT, opts = {} } = {}) {
  const list = await api("/api/v1/repos/issues/search", { query: { q, state, type, page, limit } }, opts)
  return (Array.isArray(list) ? list : []).map((i) => ({
    ...mapIssue(i, { repo: i.repository?.name ?? "" }),
    repo: i.repository?.full_name ?? i.repository?.name ?? "",
    kind: "issue",
  }))
}

export async function getUser(username, { opts = {} } = {}) {
  return api(`/api/v1/users/${enc(username)}`, {}, opts)
}


// 建单/建 PR 时 REST 只收 label id，而命令行与配置里写的是名字（needs-triage 等），
// 这里统一翻一遍；数字原样保留。
async function resolveLabelIds(repo, labels, opts) {
  if (!labels?.length) return []
  const all = await listLabels({ repo, opts })
  const byName = new Map(all.map((l) => [l.name, l.id]))
  const known = new Set(all.map((l) => String(l.id)))
  const ids = []
  const missing = []
  for (const raw of labels) {
    const w = String(raw).trim()
    if (!w) continue
    const id = /^\d+$/.test(w) && known.has(w) ? Number(w) : byName.get(w)
    if (id) ids.push(Number(id))
    else missing.push(w)
  }
  if (missing.length) {
    throw new GiteaApiError(
      `仓库 ${repo} 找不到标签 ${missing.map((x) => `"${x}"`).join(", ")}，可用: ${all.map((l) => `${l.name}=${l.id}`).join(", ") || "（仓库还没有标签）"}`,
      { code: "not_found" },
    )
  }
  return [...new Set(ids)]
}

// ---- 写：工单 ----

export async function createIssue(repo, { title, body = "", assignees = [], labels = [], milestone = null, projects = [], dueDate = null, ref = "", opts = {} } = {}) {
  const r = repoParts(repo)
  const payload = { title, body }
  if (assignees.length) payload.assignees = assignees
  if (labels.length) payload.labels = await resolveLabelIds(r.full, labels, opts)
  if (milestone) payload.milestone = Number(milestone)
  if (dueDate) payload.due_date = toRfc3339Date(dueDate)
  if (ref) payload.ref = ref
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues`, { method: "POST", body: payload }, opts)
  const mapped = mapIssue(issue, { repo: r.full })
  // 建单接口的 projects 字段在部分版本不落库，建完统一用 PATCH issues 挂项目（与 PR 一致）。
  if (projects.length && mapped.number) return setIssueProjects(r.full, mapped.number, projects, { opts })
  return mapped
}

export async function editIssue(repo, number, patch, { opts = {} } = {}) {
  const r = repoParts(repo)
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, { method: "PATCH", body: patch }, opts)
  return mapIssue(issue, { repo: r.full })
}

export async function commentIssue(repo, number, body, { opts = {} } = {}) {
  const r = repoParts(repo)
  const c = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/comments`, {
    method: "POST",
    body: { body },
  }, opts)
  return { issueNumber: Number(number), commentId: Number(c?.id) || null, url: c?.html_url ?? `${loadGiteaSettings().baseUrl}/${r.full}/issues/${number}` }
}

export async function setIssueState(repo, number, state, { opts = {} } = {}) {
  const r = repoParts(repo)
  const current = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {}, opts)
  if (current.state === state) {
    throw new GiteaApiError(
      state === "closed" ? "工单已经是关闭状态，无需重复关闭" : "工单已经是开启状态，无需重新开启",
      { code: "empty_result" },
    )
  }
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {
    method: "PATCH",
    body: { state },
  }, opts)
  return { issueNumber: Number(issue.number) || Number(number), state: issue.state, url: issue.html_url ?? "" }
}

export async function setAssignees(repo, number, { add = [], remove = [], opts = {} } = {}) {
  const r = repoParts(repo)
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {}, opts)
  const current = (issue.assignees ?? []).map(userName).filter(Boolean)
  const removeSet = new Set(remove.map(String))
  const next = current.filter((u) => !removeSet.has(u))
  for (const u of add) if (!next.includes(u)) next.push(u)
  if (next.length === current.length && next.every((u, i) => u === current[i])) {
    throw new GiteaApiError(
      add.length ? `用户 ${add.join(", ")} 已被指派，无需重复指派` : `用户 ${remove.join(", ")} 未被指派，无需取消`,
      { code: "empty_result" },
    )
  }
  const updated = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {
    method: "PATCH",
    body: { assignees: next },
  }, opts)
  return {
    issueNumber: Number(updated.number) || Number(number),
    action: add.length ? "assigned" : "unassigned",
    assignees: (updated.assignees ?? []).map(userName).filter(Boolean).join(", ") || "(none)",
    url: updated.html_url ?? "",
  }
}

export async function setDueDate(repo, number, date, { opts = {} } = {}) {
  const r = repoParts(repo)
  const clear = !date || String(date).toLowerCase() === "clear" || String(date) === "null"
  const body = { due_date: clear ? null : toRfc3339Date(date) }
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/deadline`, {
    method: "POST",
    body,
  }, opts)
  return {
    issueNumber: Number(issue?.number) || Number(number),
    deadline: issue?.due_date ? String(issue.due_date).slice(0, 10) : null,
    url: issue?.html_url ?? "",
  }
}

export async function setIssueMilestone(repo, number, milestone, { remove = false, opts = {} } = {}) {
  const r = repoParts(repo)
  if (!remove && !milestone) throw new GiteaApiError("milestone 不能为空（或使用 --remove 清除）", { code: "argument_error" })
  let id = 0
  if (!remove) {
    const list = await listMilestones(r.full, { state: "all", all: true, opts })
    const wanted = String(milestone).trim()
    // 里程碑名字本身可能就是数字（如 "1126"），所以先按 id 找，再按名字找。
    const hit = list.find((m) => String(m.id) === wanted) ?? list.find((m) => m.name === wanted)
    if (!hit) {
      throw new GiteaApiError(
        `找不到里程碑 "${wanted}"，可选: ${list.map((m) => `${m.name}=${m.id}`).join(", ") || "（仓库还没有里程碑）"}`,
        { code: "not_found" },
      )
    }
    id = hit.id
  }
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {
    method: "PATCH",
    body: { milestone: id },
  }, opts)
  return {
    issueNumber: Number(issue.number) || Number(number),
    action: remove ? "cleared" : "set",
    milestone: issue.milestone ? { id: Number(issue.milestone.id), name: issue.milestone.title } : null,
    url: issue.html_url ?? "",
  }
}

export async function editIssueLabels(repo, number, { add = [], remove = [], set = [], opts = {} } = {}) {
  const r = repoParts(repo)
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {}, opts)
  const all = await listLabels({ repo: r.full, opts })
  const byName = new Map(all.map((l) => [l.name, l.id]))
  const known = new Set(all.map((l) => String(l.id)))
  const resolve = (wanted) => {
    const ids = []
    const missing = []
    for (const w of wanted) {
      const id = known.has(String(w)) ? Number(w) : byName.get(w)
      if (id) ids.push(Number(id))
      else missing.push(w)
    }
    return { ids: [...new Set(ids)], missing }
  }

  const currentIds = (issue.labels ?? []).map((l) => Number(l.id))
  let desired = currentIds
  let wrote = false

  if (set.length) {
    const { ids, missing } = resolve(set)
    if (missing.length) {
      throw new GiteaApiError(
        `仓库中找不到标签 ${missing.map((x) => `"${x}"`).join(", ")}，可用: ${all.map((l) => `${l.name}=${l.id}`).join(", ") || "（仓库还没有标签）"}`,
        { code: "not_found" },
      )
    }
    desired = ids
    if (sameSet(desired, currentIds)) {
      return { issueNumber: Number(number), labels: (issue.labels ?? []).map(labelObj), changed: false }
    }
    await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/labels`, {
      method: "PUT",
      body: { labels: desired },
    }, opts)
    wrote = true
  } else if (add.length || remove.length) {
    const a = resolve(add)
    const d = resolve(remove)
    const missing = [...a.missing, ...d.missing]
    if (missing.length) {
      throw new GiteaApiError(
        `仓库中找不到标签 ${missing.map((x) => `"${x}"`).join(", ")}，可用: ${all.map((l) => `${l.name}=${l.id}`).join(", ") || "（仓库还没有标签）"}`,
        { code: "not_found" },
      )
    }
    const removeSet = new Set(d.ids)
    desired = currentIds.filter((id) => !removeSet.has(id))
    for (const id of a.ids) if (!desired.includes(id)) desired.push(id)
    if (sameSet(desired, currentIds)) {
      return { issueNumber: Number(number), labels: (issue.labels ?? []).map(labelObj), changed: false }
    }
    const toAdd = a.ids.filter((id) => !currentIds.includes(id))
    if (toAdd.length) {
      await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/labels`, {
        method: "POST",
        body: { labels: toAdd },
      }, opts)
      wrote = true
    }
    for (const id of d.ids.filter((id) => currentIds.includes(id))) {
      await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/labels/${enc(id)}`, { method: "DELETE" }, opts)
      wrote = true
    }
  }

  const after = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}`, {}, opts)
  return { issueNumber: Number(after.number) || Number(number), labels: (after.labels ?? []).map(labelObj), changed: wrote }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false
  const s = new Set(a.map(String))
  return b.every((x) => s.has(String(x)))
}

// ---- 写：合并请求 ----

export async function createPull(repo, { base, head, title, body = "", labels = [], assignees = [], milestone = null, projects = [], reviewers = [], draft = false, opts = {} } = {}) {
  const r = repoParts(repo)
  const payload = { base, head, title: draft ? `WIP: ${title}` : title, body }
  if (labels.length) payload.labels = await resolveLabelIds(r.full, labels, opts)
  if (assignees.length) payload.assignees = assignees
  if (milestone) payload.milestone = Number(milestone)
  if (reviewers.length) payload.reviewers = reviewers
  const pr = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls`, { method: "POST", body: payload }, opts)
  // CreatePullRequestOption 没有 projects 字段，PR 也是 issue，建完之后用 issues 接口挂项目。
  let projectsOut = []
  if (projects.length && pr?.number) {
    const updated = await setIssueProjects(r.full, Number(pr.number), projects, { opts })
    projectsOut = updated?.projects ?? []
  }
  return {
    number: Number(pr?.number) || null,
    prNumber: Number(pr?.number) || null,
    title: pr?.title ?? title,
    url: pr?.html_url ?? "",
    projects: projectsOut,
    raw: pr,
  }
}

export async function editPull(repo, number, patch, { opts = {} } = {}) {
  const r = repoParts(repo)
  const pr = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}`, { method: "PATCH", body: patch }, opts)
  return { prNumber: Number(pr.number) || Number(number), title: pr.title ?? "", body: pr.body ?? "", url: pr.html_url ?? "" }
}

export async function mergePull(repo, number, { style = "merge", title = "", message = "", deleteBranch = false, force = false, opts = {} } = {}) {
  const r = repoParts(repo)
  const current = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}`, {}, opts)
  if (current.merged) {
    throw new GiteaApiError("合并请求已合并，无需重复合并", { code: "empty_result" })
  }
  if (current.state === "closed") {
    throw new GiteaApiError(`合并请求 ${r.full}#${number} 已关闭，无法合并（请先 reopen）`, { code: "conflict" })
  }
  const payload = { do: style, delete_branch_after_merge: Boolean(deleteBranch) }
  if (title) payload.merge_title_field = title
  if (message) payload.merge_message_field = message
  if (force) payload.force_merge = true
  if (current.head?.sha) payload.head_commit_id = current.head.sha

  let resp
  try {
    resp = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}/merge`, { method: "POST", body: payload }, opts)
  } catch (e) {
    if (/already|已合并|merged/i.test(String(e.message))) {
      throw new GiteaApiError("合并请求已合并，无需重复合并", { code: "empty_result", status: e.status })
    }
    throw e
  }
  // 204 空响应也算成功；再回读一次确认状态，避免服务端静默 no-op。
  const after = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${enc(number)}`, {}, opts)
  if (!after.merged) {
    throw new GiteaApiError(`合并请求 ${r.full}#${number} 提交合并后仍未变为已合并：${resp?.message ?? "状态未生效"}`, {
      code: "gitea_error",
    })
  }
  return {
    prNumber: Number(after.number) || Number(number),
    merged: true,
    state: "merged",
    style,
    deleteBranch: Boolean(deleteBranch),
    url: after.html_url ?? "",
  }
}

// ---- 写：标签与里程碑 ----

export async function createLabel({ name, color = "#ededed", description = "", repo = "", org = "", opts = {} } = {}) {
  if (!repo && !org) throw new GiteaApiError("repo 和 org 至少提供一个", { code: "argument_error" })
  if (repo && org) throw new GiteaApiError("repo 和 org 只能提供一个", { code: "argument_error" })
  if (!name) throw new GiteaApiError("name 不能为空", { code: "argument_error" })
  const normalized = normalizeColor(color)
  if (!normalized) throw new GiteaApiError(`color 必须是 #rrggbb 形式的十六进制颜色，当前: "${color}"`, { code: "argument_error" })

  const existing = await listLabels({ repo, org, opts })
  const dup = existing.find((l) => l.name === name)
  if (dup) throw new GiteaApiError(`标签 "${name}" 已存在（id=${dup.id}，${repo ? `仓库 ${repo}` : `组织 ${org}`}）`, { code: "empty_result" })

  const pathname = repo
    ? `/api/v1/repos/${enc(repoParts(repo).owner)}/${enc(repoParts(repo).repo)}/labels`
    : `/api/v1/orgs/${enc(org)}/labels`
  const label = await api(pathname, { method: "POST", body: { name, color: normalized, description } }, opts)
  return {
    id: Number(label?.id) || null,
    scope: repo ? "repo" : "org",
    name: label?.name ?? name,
    color: label?.color ?? normalized,
    description: label?.description ?? description,
    url: label?.url ?? "",
  }
}

export async function createMilestone(repo, { title, due = "", description = "", opts = {} } = {}) {
  const r = repoParts(repo)
  if (!title) throw new GiteaApiError("title 不能为空", { code: "argument_error" })
  const payload = { title, description }
  if (due) payload.due_on = toRfc3339Date(due)
  const m = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/milestones`, { method: "POST", body: payload }, opts)
  return mapMilestone(m)
}

export async function setMilestoneState(repo, id, state, { opts = {} } = {}) {
  const r = repoParts(repo)
  const m = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/milestones/${enc(id)}`, {
    method: "PATCH",
    body: { state },
  }, opts)
  return { ...mapMilestone(m), url: "" }
}

export async function deleteMilestone(repo, id, { opts = {} } = {}) {
  const r = repoParts(repo)
  await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/milestones/${enc(id)}`, { method: "DELETE" }, opts)
  return { id: Number(id), deleted: true }
}

// ---- 分支与附件 ----

export function slugifyTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
}

export async function createIssueBranch(repo, issueNumber, { name = "", base = "", opts = {} } = {}) {
  const r = repoParts(repo)
  const issue = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(issueNumber)}`, {}, opts)
  const issueTitle = issue.title ?? ""
  const short = String(name ?? "").trim()
  const slug = short || slugifyTitle(issueTitle)
  const prefix = `issue-${issueNumber}`
  const branch = slug.startsWith(`${prefix}-`) ? slug : slug ? `${prefix}-${slug}` : prefix
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith(".") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new GiteaApiError(`分支名不合法: "${branch}"（仅允许字母/数字/-._/，不以 . 开头）`, { code: "argument_error" })
  }
  const repoInfo = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}`, {}, opts)
  const start = String(base || repoInfo.default_branch || "main")
  try {
    await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/branches/${enc(branch)}`, {}, opts)
    throw new GiteaApiError(`分支 ${branch} 已存在`, { code: "empty_result" })
  } catch (e) {
    if (e.code !== "not_found") throw e
  }
  await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/branches`, {
    method: "POST",
    body: { new_branch_name: branch, old_branch_name: start },
  }, opts)
  const created = await api(`/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/branches/${enc(branch)}`, {}, opts)
  return {
    branch: created.name ?? branch,
    base: start,
    issueNumber: Number(issueNumber),
    issueTitle,
    url: `${loadGiteaSettings().baseUrl}/${r.full}/src/branch/${branch}`,
  }
}

// 上传工单/PR 附件（图片）：先建单再上传，返回可直接写进正文的 Markdown。
export async function uploadIssueAssets(repo, number, files, { opts = {} } = {}) {
  const r = repoParts(repo)
  const uploaded = []
  for (const file of files) {
    const abs = path.resolve(expandUser(file))
    let buf
    try {
      buf = fs.readFileSync(abs)
    } catch (e) {
      throw new GiteaApiError(`读不到附件 ${abs}：${e.message}`, { code: "argument_error" })
    }
    const form = new FormData()
    form.append("attachment", new Blob([buf]), path.basename(abs))
    const asset = await api(
      `/api/v1/repos/${enc(r.owner)}/${enc(r.repo)}/issues/${enc(number)}/assets`,
      { method: "POST", query: { name: path.basename(abs) }, body: form },
      opts,
    )
    uploaded.push({
      name: asset?.name ?? path.basename(abs),
      uuid: asset?.uuid ?? null,
      url: asset?.browser_download_url ?? "",
    })
  }
  return uploaded
}

function expandUser(p) {
  const s = String(p)
  if (s === "~") return process.env.HOME ?? s
  if (s.startsWith("~/")) return `${process.env.HOME ?? ""}/${s.slice(2)}`
  return s
}

export function toRfc3339Date(date) {
  const s = String(date ?? "").trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new GiteaApiError(`日期必须是 YYYY-MM-DD，当前: "${s}"`, { code: "argument_error" })
  }
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new GiteaApiError(`日期不合法: "${s}"`, { code: "argument_error" })
  return `${s}T00:00:00Z`
}

function normalizeColor(raw) {
  const s = String(raw ?? "").trim()
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s)
  if (!m) return null
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]
  return `#${hex.toLowerCase()}`
}
