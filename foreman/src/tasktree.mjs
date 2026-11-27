// foreman tasks：主体是已分配会话及其父子树；工单只作为节点的归属与容量元数据。
import { Book } from "./book.mjs"

const UNRESOLVED = new Set(["planned", "handed", "working", "pr-open", "needs-human", "blocked", "failed", "escalated"])

function roleName(kind = "", role = "") {
  const value = String(role || kind)
  if (value === "orchestrator") return "编排智能体"
  if (value === "worker") return "编码智能体"
  if (value === "router") return "路由智能体"
  if (String(kind) === "deliver:merge") return "合并智能体"
  if (String(kind) === "deliver" || String(kind).startsWith("deliver:")) return "执行智能体"
  return value || "执行智能体"
}

function nodeSort(a, b) {
  return String(a.issueKey).localeCompare(String(b.issueKey))
    || String(a.name).localeCompare(String(b.name))
    || String(a.convId).localeCompare(String(b.convId))
}

export function buildSessionTree(book, sidebar = null) {
  const nodes = new Map()
  const aliases = new Map()

  const canonical = (ref) => {
    const value = String(ref ?? "").trim()
    return aliases.get(value) ?? value
  }

  const attachIssue = (node, issueKey, rec = {}) => {
    const key = String(issueKey ?? "").trim()
    if (!key) return
    node.issueKeys = [...new Set([...node.issueKeys, key])]
    node.issueStates[key] = String(rec?.state ?? "")
    if (!node.issueKey) {
      node.issueKey = key
      node.issueState = String(rec?.state ?? "")
      node.issueTitle = String(rec?.title ?? "")
    }
  }

  const ensure = (ref, patch = {}) => {
    const requested = String(ref ?? "").trim()
    if (!requested) return null
    const id = canonical(requested)
    const prev = nodes.get(id) ?? {
      convId: id,
      name: "",
      kind: "",
      role: "",
      roles: [],
      roleName: "执行智能体",
      parent: "",
      issueKey: "",
      issueState: "",
      issueTitle: "",
      issueKeys: [],
      issueStates: {},
      prKey: "",
      prMerged: false,
      prUrl: "",
      childIds: [],
      updatedAt: "",
      createdAt: "",
    }
    const node = { ...prev }
    for (const key of ["name", "kind", "role", "parent", "updatedAt", "createdAt"]) {
      if (String(patch[key] ?? "").trim()) node[key] = String(patch[key]).trim()
    }
    const nextRole = String(patch.role || patch.kind || "").trim()
    node.roles = [...new Set([...prev.roles, ...(nextRole ? [nextRole] : [])])]
    node.roleName = [...new Set(node.roles.map((role) => roleName(role, role)))].join(" / ") || roleName(node.kind, node.role)
    nodes.set(id, node)
    aliases.set(id, id)
    if (node.name) aliases.set(node.name, id)
    if (patch.issueKey) attachIssue(node, patch.issueKey, patch.issue ?? {})
    return node
  }

  // 先放显式会话记录，建立 id/标题别名；工单与 watch 只补关系和缺失节点。
  for (const [name, rec] of Object.entries(book?.sessions ?? {})) {
    ensure(rec?.convId || name, {
      name,
      kind: rec?.kind,
      role: rec?.role,
      parent: rec?.parent,
      issueKey: rec?.issueKey,
      issue: book?.issue?.(rec?.issueKey) ?? {},
      updatedAt: rec?.updatedAt,
      createdAt: rec?.createdAt,
    })
  }

  for (const [key, rec] of Object.entries(book?.prSeen ?? {})) {
    if (!rec?.assignedConvId) continue
    const node = ensure(rec.assignedConvId, {
      name: rec?.assignedTo,
      kind: "deliver:merge",
      createdAt: rec?.assignedAt,
    })
    node.prKey = key
    node.prMerged = rec?.merged === true
    node.prUrl = String(rec?.url ?? "")
  }

  for (const [key, rec] of Object.entries(book?.issues ?? {})) {
    const parent = String(rec?.orchestrator ?? "").trim()
    if (parent) ensure(parent, { kind: "orchestrator", role: "orchestrator", issueKey: key, issue: rec })
    const worker = String(rec?.agentConvId ?? "").trim() || String(rec?.agent ?? "").trim()
    if (worker) ensure(worker, {
      name: rec?.agent,
      kind: "worker",
      role: "worker",
      parent,
      issueKey: key,
      issue: rec,
    })
  }

  for (const watch of book?.watch ?? []) {
    const issueKey = String(watch?.issueKey ?? "").trim()
    const issue = book?.issue?.(issueKey) ?? {}
    const parent = String(watch?.parent ?? "").trim() || String(issue?.orchestrator ?? "").trim()
    ensure(watch?.target || watch?.name, {
      name: watch?.name,
      kind: "worker",
      role: "worker",
      parent,
      issueKey,
      issue,
    })
  }

  // 父子关系只认会话；父记录缺失时保留 parent 供排障，但该节点仍作为根展示。
  for (const [id, node] of nodes) {
    const parent = canonical(node.parent)
    node.parent = parent
    if (!parent || parent === id || !nodes.has(parent)) continue
    let cursor = parent
    let cycle = false
    const seen = new Set([id])
    while (cursor) {
      if (seen.has(cursor)) { cycle = true; break }
      seen.add(cursor)
      cursor = canonical(nodes.get(cursor)?.parent)
    }
    if (!cycle) nodes.get(parent).childIds.push(id)
  }

  const materialize = (id, stack = new Set()) => {
    const node = nodes.get(id)
    const side = sidebar?.[id]
    const state = sidebar === null ? "unknown" : side ? (side.running === true ? "running" : "idle") : "gone"
    const noticed = book?.notified?.[id] ?? {}
    const children = node.childIds
      .filter((child) => !stack.has(child))
      .sort((a, b) => nodeSort(nodes.get(a), nodes.get(b)))
      .map((child) => materialize(child, new Set([...stack, child])))
    return {
      convId: id,
      name: node.name || side?.title || id,
      title: String(side?.title ?? ""),
      kind: node.kind,
      role: node.role,
      roles: node.roles,
      roleName: node.roleName,
      state,
      running: sidebar === null ? null : side?.running === true,
      active: side?.active === true,
      parent: node.parent,
      issueKey: node.issueKey,
      issueState: node.issueState,
      issueTitle: node.issueTitle,
      issueKeys: node.issueKeys,
      issueStates: node.issueStates,
      prKey: node.prKey,
      prMerged: node.prMerged,
      prUrl: node.prUrl,
      lastPhase: String(noticed.observedPhase ?? noticed.phase ?? ""),
      updatedAt: node.updatedAt,
      createdAt: node.createdAt,
      children,
    }
  }

  const roots = [...nodes.keys()]
    .filter((id) => !nodeHasParent(nodes, id))
    .sort((a, b) => nodeSort(nodes.get(a), nodes.get(b)))
    .map((id) => materialize(id, new Set([id])))
  const keepCurrent = (node) => {
    node.children = node.children.filter(keepCurrent)
    const hasUnresolvedIssue = node.issueKeys.some((key) => UNRESOLVED.has(node.issueStates[key]))
    const hasOpenPr = Boolean(node.prKey) && node.prMerged !== true
    return node.state !== "gone" || node.children.length > 0 || hasUnresolvedIssue || hasOpenPr || node.roles.includes("router")
  }
  return roots.filter(keepCurrent)
}

function nodeHasParent(nodes, id) {
  const node = nodes.get(id)
  const parent = node?.parent
  if (!parent || parent === id || !nodes.has(parent)) return false
  return nodes.get(parent).childIds.includes(id)
}

export async function sessionTasks(ctx) {
  const book = new Book(ctx.cfg.stateFile)
  let sidebar = null
  let statusError = ""
  if (typeof ctx.session?.runningMap === "function") {
    try {
      sidebar = await ctx.session.runningMap()
    } catch (e) {
      statusError = String(e?.message ?? e)
    }
  } else {
    statusError = "DWS 不支持 runningMap"
  }
  const sessions = buildSessionTree(book, sidebar)
  const flat = []
  const visit = (nodes) => {
    for (const node of nodes) {
      flat.push(node)
      visit(node.children)
    }
  }
  visit(sessions)
  const issues = Object.values(book.issues ?? {})
  const count = (state) => flat.filter((n) => n.state === state).length
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    statusSource: sidebar === null ? "unavailable" : "session.list",
    statusError,
    summary: {
      sessions: flat.length,
      runningSessions: count("running"),
      idleSessions: count("idle"),
      goneSessions: count("gone"),
      unknownSessions: count("unknown"),
      runningWorkers: flat.filter((n) => n.state === "running" && n.roles.includes("worker")).length,
      unresolvedIssues: issues.filter((rec) => UNRESOLVED.has(String(rec?.state ?? ""))).length,
      prOpenIssues: issues.filter((rec) => String(rec?.state ?? "") === "pr-open").length,
    },
    sessions,
  }
}

function taskLine(node) {
  const issue = node.issueKey ? ` · ${node.issueKey}${node.issueState ? ` [${node.issueState}]` : ""}` : ""
  const pr = node.prKey ? ` · PR ${node.prKey}${node.prMerged ? " [merged]" : " [open]"}` : ""
  return `${node.convId} · ${node.roleName} · ${node.state}${issue}${pr} · ${node.name}`
}

export function formatSessionTasks(result) {
  const summary = result?.summary ?? {}
  const lines = [
    `已分配会话 ${summary.sessions ?? 0} 个 · 运行中 ${summary.runningSessions ?? 0} · 空闲 ${summary.idleSessions ?? 0} · 已离开侧边栏 ${summary.goneSessions ?? 0} · 状态未知 ${summary.unknownSessions ?? 0}`,
  ]
  if (result?.statusError) lines.push(`会话状态读取失败：${result.statusError}`)
  const render = (node, prefix, connector) => {
    lines.push(`${prefix}${connector}${taskLine(node)}`)
    const childPrefix = connector === "- " ? "  " : `${prefix}${connector.startsWith("└") ? "   " : "│  "}`
    node.children.forEach((child, index) => {
      render(child, childPrefix, `${index === node.children.length - 1 ? "└─" : "├─"} `)
    })
  }
  for (const root of result?.sessions ?? []) render(root, "", "- ")
  if (!(result?.sessions ?? []).length) lines.push("还没有分配会话。")
  return `${lines.join("\n")}\n`
}
