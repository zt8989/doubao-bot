// Gitea 适配层：一律走 REST API（令牌放在 ~/.foreman/gitea-token）。
// 以前这里是 opencli 浏览器自动化（每条 20–40s）；现在单次调用几十毫秒，无需 Chrome 登录态。
import * as api from "../../gitea/src/api.mjs"
import { GiteaApiError, loadGiteaSettings, ping } from "../../gitea/src/client.mjs"

export class GiteaError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, { code: "gitea_error" }, extra)
  }
}

function wrap(fn) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      if (e instanceof GiteaApiError) throw new GiteaError(e.message, { code: e.code, status: e.status, body: e.body })
      throw e
    }
  }
}

export const settings = () => loadGiteaSettings()

export const giteaHealth = async () => {
  const s = loadGiteaSettings()
  if (!s.token) {
    return { ok: false, detail: `缺少令牌：写入 ${s.tokenFile || "~/.foreman/gitea-token"}（Gitea 设置 → 应用）` }
  }
  try {
    const v = await ping({ settings: s })
    return { ok: true, detail: `REST 可用（${s.baseUrl}，Gitea ${v?.version ?? "?"}，令牌 ${s.tokenSource}）` }
  } catch (e) {
    return { ok: false, detail: String(e.message).slice(0, 200) }
  }
}

export const listIssues = wrap(async (repo, { state = "open", label = "", page = 1 } = {}) =>
  api.listIssues(repo, { state, labels: label, page }))

export const viewIssue = wrap(async (repo, n) => api.viewIssue(repo, n))

// 建单：一条龙的起点。labels/assignees 走 Gitea REST 的 id/用户名数组，先不暴露（要时再加解析）。
export const createIssue = wrap(async (repo, { title, body = "" } = {}) =>
  api.createIssue(repo, { title, body }))

// 改单字段（标题/正文/分支 ref…）：Issue.ref（右侧分支）是 Gitea 特有，适配器按能力位暴露。
export const editIssue = wrap(async (repo, n, patch) => api.editIssue(repo, n, patch))

export const commentIssue = wrap(async (repo, n, body) => api.commentIssue(repo, n, body))

export const closeIssue = wrap(async (repo, n) => api.setIssueState(repo, n, "closed"))

export const reopenIssue = wrap(async (repo, n) => api.setIssueState(repo, n, "open"))

export const editLabels = wrap(async (repo, n, { add = "", remove = "" } = {}) => {
  const toList = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const a = toList(add)
  const d = toList(remove)
  if (!a.length && !d.length) return null
  return api.editIssueLabels(repo, n, { add: a, remove: d })
})

export const READY_FOR_AGENT = "ready-for-agent"
export const READY_FOR_HUMAN = "ready-for-human"

// PR 建好后工单交回人工：摘 ready-for-agent、打 ready-for-human（幂等，两标签都在时只保留后者）。
export const readyForHuman = wrap(async (repo, n) =>
  api.editIssueLabels(repo, n, { add: [READY_FOR_HUMAN], remove: [READY_FOR_AGENT] }))

export const viewPr = wrap(async (repo, pr, { files = false } = {}) => api.viewPull(repo, pr, { files }))

// PR diff 原文（接口变更巡检用）：Gitea .diff 端点的纯文本。
export const pullPrDiff = wrap(async (repo, pr) => api.pullDiff(repo, pr))

export const assign = wrap(async (repo, n, username) => api.setAssignees(repo, n, { add: [String(username ?? "").trim()] }))

export const listPulls = wrap(async (repo, { state = "open", page = 1 } = {}) =>
  api.listPulls(repo, { state, page }))

export const createPr = wrap(async ({ repo, base, head, title, body = "" }) =>
  api.createPull(repo, { base, head, title, body }))

export const mergePr = wrap(async (repo, pr, { style = "merge", deleteBranch = false, timeout = 30000 } = {}) =>
  api.mergePull(repo, pr, { style, deleteBranch, timeout }))

export function repoOfUrl(url) {
  const m = String(url ?? "").match(/^http:\/\/[^/]+\/([^/]+)\/([^/]+)\/(issues|pulls)\//)
  return m ? `${m[1]}/${m[2]}` : ""
}
