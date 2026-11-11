// Gitea：一律走 opencli 的 gitea 子命令（复用 Chrome 已登录会话，不需要 token）。
// 注意：每条命令 20–40 秒（要开浏览器），调用方要么后台跑要么给足超时。
import { exec, extractJson } from "./util.mjs"

export class GiteaError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, { code: "gitea_error" }, extra)
  }
}

export async function gitea(args, { timeout = 180000 } = {}) {
  let raw
  try {
    const r = await exec("opencli", ["gitea", ...args, "-f", "json"], { timeout })
    raw = r.stdout
  } catch (e) {
    raw = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim()
    throw new GiteaError(`opencli gitea ${args[0]} 失败：${raw.slice(-2000) || e.message}`, {
      args,
      output: raw,
    })
  }
  let parsed
  try {
    parsed = extractJson(raw)
  } catch (e) {
    throw new GiteaError(`opencli gitea ${args[0]} 输出无法解析：${raw.slice(-1500)}`, { args })
  }
  if (parsed.ok === false) {
    throw new GiteaError(`opencli gitea ${args[0]}：${parsed.error ?? "未知错误"}`, { args, output: parsed })
  }
  return parsed
}

const data = (r) => r?.data ?? r

export async function listIssues(repo, { state = "open", label = "", page = 1 } = {}) {
  const args = ["search", "", "--repo", repo, "--state", state]
  if (label) args.push("--label", label)
  if (page > 1) args.push("--page", String(page))
  const d = data(await gitea(args))
  const list = Array.isArray(d) ? d : (d?.issues ?? d?.items ?? [])
  return list.map((x) => ({
    number: Number(x.number ?? x.issueNumber),
    title: x.title ?? "",
    state: x.state ?? "",
    labels: (x.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    assignees: (x.assignees ?? []).map((a) => (typeof a === "string" ? a : a.name ?? a.username)).filter(Boolean),
    author: x.author?.name ?? x.author?.username ?? x.creator?.name ?? x.creator ?? "",
    url: x.url ?? "",
    createdAt: x.createdAt ?? x.created_at ?? "",
  }))
}

export async function viewIssue(repo, n) {
  const d = data(await gitea(["issue-view", String(n), "--repo", repo]))
  const obj = Array.isArray(d) ? d[0] : d
  return {
    number: Number(obj?.number ?? obj?.issueNumber ?? n),
    title: obj?.title ?? "",
    state: obj?.state ?? "",
    body: obj?.body ?? obj?.description ?? "",
    labels: (obj?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    assignees: (obj?.assignees ?? []).map((a) => (typeof a === "string" ? a : a.name ?? a.username)).filter(Boolean),
    url: obj?.url ?? "",
    comments: obj?.comments ?? [],
    raw: obj,
  }
}

export async function commentIssue(repo, n, body) {
  return data(await gitea(["issue-comment", String(n), body, "--repo", repo]))
}

export async function closeIssue(repo, n) {
  return data(await gitea(["close", String(n), "--repo", repo]))
}

export async function editLabels(repo, n, { add = "", remove = "" } = {}) {
  const args = ["issue-edit", String(n), "--repo", repo]
  if (add) args.push("--label-add", add)
  if (remove) args.push("--label-remove", remove)
  if (args.length === 4) return null
  return data(await gitea(args))
}

export async function viewPr(repo, pr) {
  return data(await gitea(["pr-view", String(pr), "--repo", repo]))
}

// 列仓库的合并请求（open/closed/all），带回 author；列表页不回 base/head，要看分支用 viewPr。
export async function listPulls(repo, { state = "open", page = 1 } = {}) {
  const args = ["pull-list", "--repo", repo, "--state", state]
  if (page > 1) args.push("--page", String(page))
  const d = data(await gitea(args))
  const list = Array.isArray(d) ? d : (d?.pulls ?? d?.items ?? [])
  return list.map((x) => ({
    number: Number(x.number ?? x.pullNumber),
    repo: x.repo ?? repo,
    title: x.title ?? "",
    state: x.state ?? "",
    author: x.author ?? null,
    labels: (x.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    assignees: (x.assignees ?? []).map((a) => (typeof a === "string" ? a : a.name ?? a.username)).filter(Boolean),
    author: x.author?.name ?? x.author?.username ?? x.creator?.name ?? x.creator ?? "",
    url: x.url ?? "",
    createdAt: x.createdAt ?? x.created_at ?? "",
    updatedAt: x.updatedAt ?? x.updated_at ?? "",
  }))
}

export async function createPr({ repo, base, head, title, body = "" }) {
  const d = data(
    await gitea(["pr", "--repo", repo, "--base", base, "--head", head, "--title", title, "--body", body])
  )
  const obj = Array.isArray(d) ? d[0] : d
  const number = Number(
    obj?.prNumber ?? obj?.number ?? obj?.pullNumber ?? (String(obj?.url ?? "").match(/\/pulls\/(\d+)/) ?? [])[1]
  )
  return { number, url: obj?.url ?? "", raw: obj }
}

export async function mergePr(repo, pr, { style = "merge", deleteBranch = false, timeout = 180000 } = {}) {
  const args = ["pr-merge", String(pr), "--repo", repo, "--style", style]
  if (deleteBranch) args.push("--delete-branch")
  return data(await gitea(args, { timeout }))
}

export function repoOfUrl(url) {
  const m = String(url ?? "").match(/^http:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\//)
  return m ? `${m[1]}/${m[2]}` : ""
}
