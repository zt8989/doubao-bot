// CLI：与旧 opencli gitea 命令同名同参，输出 { ok, data } / { ok:false, error }。
// 只是 REST 的薄壳；业务判断（找不到标签、已合并、无差异）都在 api.mjs 里。
import {
  listIssues,
  viewIssue,
  listPulls,
  viewPull,
  createIssue,
  editIssue,
  commentIssue,
  setIssueState,
  setAssignees,
  setDueDate,
  setIssueMilestone,
  editIssueLabels,
  resolveProjectIds,
  createPull,
  editPull,
  mergePull,
  listLabels,
  createLabel,
  listMilestones,
  createMilestone,
  setMilestoneState,
  deleteMilestone,
  createIssueBranch,
  uploadIssueAssets,
  searchIssuesAcross,
  searchRepos,
  listMyRepos,
  getUser,
  repoParts,
} from "./api.mjs"
import { GiteaApiError, loadGiteaSettings } from "./client.mjs"

const BOOL = new Set(["files", "remove", "draft", "delete-branch", "force", "reopen", "append", "help", "h"])
const IGNORED = new Set(["f", "format", "window", "site-session", "keep-tab"])

export function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a)
      continue
    }
    const name = a.replace(/^--?/, "")
    if (name.includes("=")) {
      const [k, ...rest] = name.split("=")
      flags[k] = rest.join("=")
      continue
    }
    if (BOOL.has(name)) {
      flags[name] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("-")) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { flags, positionals }
}

function need(flags, name, { required = true, fallback = "" } = {}) {
  const v = flags[name]
  if (v === undefined || v === "" || v === true) {
    if (required) throw new GiteaApiError(`缺少参数 --${name}`, { code: "argument_error" })
    return fallback
  }
  return String(v)
}

function numArg(flags, pos, idx = 0, flagName = "issue") {
  const raw = pos[idx] ?? flags[flagName]
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new GiteaApiError(`编号必须是正整数，当前: "${raw}"`, { code: "argument_error" })
  return n
}

const split = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean)

const NEED_REPO = (flags) => repoParts(need(flags, "repo")).full

const commands = {
  async search(flags, pos) {
    const repo = NEED_REPO(flags)
    const data = await listIssues(repo, {
      q: pos[0] ?? need(flags, "query", { required: false, fallback: "" }),
      state: need(flags, "state", { required: false, fallback: "open" }),
      labels: need(flags, "label", { required: false, fallback: "" }),
      assignee: need(flags, "assignee", { required: false, fallback: "" }),
      milestone: need(flags, "milestone", { required: false, fallback: "" }),
      page: Number(need(flags, "page", { required: false, fallback: "1" })),
    })
    return data
  },

  async "pull-list"(flags) {
    const repo = NEED_REPO(flags)
    return listPulls(repo, {
      state: need(flags, "state", { required: false, fallback: "open" }),
      page: Number(need(flags, "page", { required: false, fallback: "1" })),
    })
  },

  async "issue-view"(flags, pos) {
    const repo = NEED_REPO(flags)
    return viewIssue(repo, numArg(flags, pos, 0), { withComments: true })
  },

  async "pr-view"(flags, pos) {
    const repo = NEED_REPO(flags)
    return viewPull(repo, numArg(flags, pos, 0, "pr"), { files: Boolean(flags.files) })
  },

  async issue(flags, pos) {
    const repo = NEED_REPO(flags)
    const title = String(flags.title ?? pos[0] ?? "").trim()
    if (!title) throw new GiteaApiError("缺少 --title", { code: "argument_error" })
    const images = split(flags.image)
    const labels = split(flags.label)
    const assignees = split(flags.assignee)
    const milestone = flags.milestone ? await resolveMilestone(repo, flags.milestone) : null
    const projects = flags.project ? await resolveProjectIds(repo, split(flags.project)) : []
    const created = await createIssue(repo, {
      title,
      body: String(flags.body ?? ""),
      labels,
      assignees,
      milestone,
      projects,
      dueDate: flags.due ? String(flags.due) : null,
      ref: flags.ref ? String(flags.ref) : "",
    })
    if (images.length) {
      const uploaded = await uploadIssueAssets(repo, created.number, images)
      const md = uploaded.map((u) => `![${u.name}](${u.url})`).join("\n")
      const body = [String(flags.body ?? "").trim(), md].filter(Boolean).join("\n\n")
      await editIssue(repo, created.number, { body })
      created.body = body
      created.assets = uploaded
    }
    return { issueNumber: created.number, number: created.number, title: created.title, url: created.url, labels: created.labels, assignees: created.assignees, projects: (created.projects ?? []).map((p) => p.title) }
  },

  async "issue-comment"(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0)
    const body = String(pos[1] ?? flags.body ?? "").trim()
    if (!body) throw new GiteaApiError("评论正文不能为空", { code: "argument_error" })
    return commentIssue(repo, n, body)
  },

  async "issue-edit"(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0)
    const title = String(flags.title ?? "").trim()
    const bodyRaw = String(flags.body ?? "")
    const append = Boolean(flags.append)
    const add = split(flags["label-add"])
    const remove = split(flags["label-remove"])
    const set = split(flags["set-labels"])
    if (!title && !bodyRaw && !add.length && !remove.length && !set.length) {
      throw new GiteaApiError("至少提供 --title、--body、--label-add、--label-remove、--set-labels 之一", { code: "argument_error" })
    }
    if (append && !bodyRaw) throw new GiteaApiError("--append 需要配合 --body", { code: "argument_error" })
    if (set.length && (add.length || remove.length)) throw new GiteaApiError("--set-labels 与 label-add/label-remove 不能同时使用", { code: "argument_error" })

    let body = bodyRaw
    if (append && bodyRaw) {
      const current = await viewIssue(repo, n, { withComments: false })
      body = [String(current.body ?? "").replace(/\s+$/, ""), bodyRaw].filter(Boolean).join("\n\n")
    }
    const patch = {}
    if (title) patch.title = title
    if (body) patch.body = body
    if (Object.keys(patch).length) await editIssue(repo, n, patch)
    const labels = set.length || add.length || remove.length
      ? await editIssueLabels(repo, n, { add, remove, set })
      : null
    return { issueNumber: n, title: title || undefined, labels: labels?.labels ?? [], changed: true }
  },

  async close(flags, pos) {
    return setIssueState(NEED_REPO(flags), numArg(flags, pos, 0), "closed")
  },

  async reopen(flags, pos) {
    return setIssueState(NEED_REPO(flags), numArg(flags, pos, 0), "open")
  },

  async assign(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0)
    const user = String(pos[1] ?? flags.user ?? "").trim()
    if (!user) throw new GiteaApiError("user 不能为空", { code: "argument_error" })
    return setAssignees(repo, n, flags.remove ? { remove: [user] } : { add: [user] })
  },

  async due(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0)
    const date = String(pos[1] ?? flags.date ?? "").trim()
    if (!date) throw new GiteaApiError("date 必须是 YYYY-MM-DD 或 clear", { code: "argument_error" })
    if (!/^(clear|\d{4}-\d{2}-\d{2})$/i.test(date)) throw new GiteaApiError(`date 必须是 YYYY-MM-DD 或 clear，当前: "${date}"`, { code: "argument_error" })
    return setDueDate(repo, n, date)
  },

  async "milestone-set"(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0)
    const ms = String(pos[1] ?? flags.milestone ?? "").trim()
    return setIssueMilestone(repo, n, ms, { remove: Boolean(flags.remove) })
  },

  async branch(flags, pos) {
    const repo = NEED_REPO(flags)
    return createIssueBranch(repo, numArg(flags, pos, 0), {
      name: String(pos[1] ?? flags.name ?? "").trim(),
      base: need(flags, "base", { required: false, fallback: "" }),
    })
  },

  async pr(flags) {
    const repo = NEED_REPO(flags)
    const title = need(flags, "title")
    const base = need(flags, "base")
    const head = need(flags, "head")
    const created = await createPull(repo, {
      base,
      head,
      title,
      body: String(flags.body ?? ""),
      labels: split(flags.label),
      assignees: split(flags.assignee),
      milestone: flags.milestone ? await resolveMilestone(repo, flags.milestone) : null,
      projects: flags.project ? await resolveProjectIds(repo, split(flags.project)) : [],
      reviewers: split(flags.reviewer),
      draft: Boolean(flags.draft),
    })
    const images = split(flags.image)
    if (images.length) {
      const uploaded = await uploadIssueAssets(repo, created.number, images)
      const md = uploaded.map((u) => `![${u.name}](${u.url})`).join("\n")
      const body = [String(flags.body ?? "").trim(), md].filter(Boolean).join("\n\n")
      await editPull(repo, created.number, { body })
      created.assets = uploaded
    }
    return { prNumber: created.prNumber, number: created.number, title: created.title, url: created.url, projects: (created.projects ?? []).map((p) => p.title) }
  },

  async "pr-edit"(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0, "pr")
    const title = String(flags.title ?? "").trim()
    const bodyRaw = String(flags.body ?? "")
    if (!title && !bodyRaw) throw new GiteaApiError("--title 和 --body 至少提供一个", { code: "argument_error" })
    if (flags.append && !bodyRaw) throw new GiteaApiError("--append 需要配合 --body", { code: "argument_error" })
    let body = bodyRaw
    if (flags.append && bodyRaw) {
      const current = await viewPull(repo, n, { files: false })
      body = [String(current.body ?? "").replace(/\s+$/, ""), bodyRaw].filter(Boolean).join("\n\n")
    }
    const patch = {}
    if (title) patch.title = title
    if (body) patch.body = body
    return editPull(repo, n, patch)
  },

  async "pr-merge"(flags, pos) {
    const repo = NEED_REPO(flags)
    const n = numArg(flags, pos, 0, "pr")
    return mergePull(repo, n, {
      style: need(flags, "style", { required: false, fallback: "merge" }),
      title: String(flags.title ?? ""),
      message: String(flags.message ?? ""),
      deleteBranch: Boolean(flags["delete-branch"]),
      force: Boolean(flags.force),
    })
  },

  async "label-list"(flags) {
    return listLabels({
      repo: need(flags, "repo", { required: false, fallback: "" }),
      org: need(flags, "org", { required: false, fallback: "" }),
    })
  },

  async "label-create"(flags, pos) {
    const name = String(pos[0] ?? flags.name ?? "").trim()
    return createLabel({
      name,
      color: need(flags, "color", { required: false, fallback: "#ededed" }),
      description: String(flags.description ?? ""),
      repo: need(flags, "repo", { required: false, fallback: "" }),
      org: need(flags, "org", { required: false, fallback: "" }),
    })
  },

  async milestone(flags, pos) {
    const repo = NEED_REPO(flags)
    return listMilestones(repo, {
      state: need(flags, "state", { required: false, fallback: "open" }),
      query: String(pos[0] ?? flags.query ?? ""),
      page: Number(need(flags, "page", { required: false, fallback: "1" })),
      all: need(flags, "state", { required: false, fallback: "open" }) === "all",
    })
  },

  async "milestone-create"(flags, pos) {
    const repo = NEED_REPO(flags)
    const title = String(pos[0] ?? flags.title ?? "").trim()
    return createMilestone(repo, {
      title,
      due: need(flags, "due", { required: false, fallback: "" }),
      description: String(flags.description ?? ""),
    })
  },

  async "milestone-close"(flags, pos) {
    const repo = NEED_REPO(flags)
    const id = await resolveMilestone(repo, pos[0] ?? flags.milestone)
    return setMilestoneState(repo, id, flags.reopen ? "open" : "closed")
  },

  async "milestone-delete"(flags, pos) {
    const repo = NEED_REPO(flags)
    const id = await resolveMilestone(repo, pos[0] ?? flags.milestone)
    return deleteMilestone(repo, id)
  },

  async explore(flags, pos) {
    const kind = String(pos[0] ?? "").trim()
    const query = String(pos[1] ?? flags.query ?? "").trim()
    const state = need(flags, "state", { required: false, fallback: "open" })
    const page = Number(need(flags, "page", { required: false, fallback: "1" }))
    if (!["issues", "pulls", "milestones", "repos"].includes(kind)) {
      throw new GiteaApiError("kind 必须是 issues/pulls/milestones/repos", { code: "argument_error" })
    }
    if (kind === "repos") {
      return (await searchRepos(query, { page })).map((r) => ({ kind: "repo", repo: r.repo, title: r.name, state: "", url: r.htmlUrl }))
    }
    if (kind === "issues" || kind === "pulls") {
      const list = await searchIssuesAcross({ q: query, state, type: kind === "issues" ? "issues" : "pulls", page })
      return list.map((i) => ({ kind: kind === "issues" ? "issue" : "pull", repo: i.repo, number: i.number, title: i.title, state: i.state, url: i.url }))
    }
    const repos = await listMyRepos({ limit: 50 })
    const out = []
    for (const r of repos) {
      try {
        const list = await listMilestones(r.repo, { state: state === "all" ? "all" : state, query, all: state === "all" })
        for (const m of list) {
          if (query && !String(m.name).toLowerCase().includes(query.toLowerCase())) continue
          out.push({ kind: "milestone", repo: r.repo, number: m.id, title: m.name, state: m.state, due: m.due, url: "" })
        }
      } catch {}
    }
    return out
  },
}

async function resolveMilestone(repo, value) {
  const wanted = String(value ?? "").trim()
  if (!wanted) throw new GiteaApiError("milestone 不能为空", { code: "argument_error" })
  const list = await listMilestones(repo, { state: "all", all: true })
  const hit = list.find((m) => String(m.id) === wanted) ?? list.find((m) => m.name === wanted)
  if (!hit) {
    throw new GiteaApiError(`找不到里程碑 "${wanted}"，可选: ${list.map((m) => `${m.name}=${m.id}`).join(", ") || "（仓库还没有里程碑）"}`, { code: "not_found" })
  }
  return hit.id
}

const USAGE = `gitea — 内网 Gitea REST API 客户端（替代 opencli 浏览器自动化）

读：
  gitea search [query] --repo <owner/name> [--state open|closed|all] [--label ids] [--assignee user|none|any] [--milestone name|id|none] [--page N]
  gitea pull-list --repo <owner/name> [--state ...] [--page N]
  gitea issue-view <n> --repo <owner/name>
  gitea pr-view <n> --repo <owner/name> [--files]
  gitea label-list (--repo <owner/name> | --org <org>)
  gitea milestone [query] --repo <owner/name> [--state open|closed|all]
  gitea explore issues|pulls|milestones|repos [query] [--state ...] [--page N]

写：
  gitea issue --repo R --title T [--body MD] [--label a,b] [--assignee u] [--milestone M] [--project 「项目」看板名|id] [--due YYYY-MM-DD] [--ref branch] [--image p1,p2]
  gitea issue-comment <n> <body> --repo R
  gitea issue-edit <n> --repo R [--title T] [--body MD] [--append] [--label-add a,b] [--label-remove a,b] [--set-labels a,b]
  gitea close|reopen <n> --repo R
  gitea assign <n> <user> --repo R [--remove]
  gitea due <n> <YYYY-MM-DD|clear> --repo R
  gitea milestone-set <n> [milestone] --repo R [--remove]
  gitea branch <issue> [name] --repo R [--base B]
  gitea pr --repo R --base B --head H --title T [--body MD] [--draft] [--label a,b] [--assignee u] [--reviewer u] [--milestone M] [--project 「项目」看板名|id] [--image p]
  gitea pr-edit <n> --repo R [--title T] [--body MD] [--append]
  gitea pr-merge <n> --repo R [--style merge|rebase|rebase-merge|squash|fast-forward-only] [--title T] [--message M] [--delete-branch] [--force]
  gitea label-create <name> [--color #rrggbb] [--description D] (--repo R | --org O)
  gitea milestone-create <title> --repo R [--due YYYY-MM-DD] [--description D]
  gitea milestone-close <id|name> --repo R [--reopen]
  gitea milestone-delete <id|name> --repo R

鉴权：GITEA_TOKEN / ~/.foreman/gitea-token / config gitea.token；站点 GITEA_BASE_URL。
术语：仓库/工程=repo（--repo 必填）；「项目」=Gitea Projects 看板（--project），与仓库不是一回事。`

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv)
  if (flags.help || flags.h || positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const name = positionals.shift()
  const fn = commands[name]
  if (!fn) throw new GiteaApiError(`不认识的命令：${name}（gitea --help 看清单）`, { code: "argument_error" })
  for (const key of Object.keys(flags)) {
    if (IGNORED.has(key)) delete flags[key]
  }
  const data = await fn(flags, positionals)
  const payload = { ok: true, data }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

export { GiteaApiError, loadGiteaSettings }
