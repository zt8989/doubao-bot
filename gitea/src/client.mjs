// Gitea REST 客户端：令牌与站点地址的解析、统一的请求与错误口径。
// 令牌来源（按优先级）：GITEA_TOKEN → GITEA_TOKEN_FILE → config gitea.tokenFile
//   → ~/.foreman/gitea-token → ~/.config/gitea/token → config gitea.token。
// 站点地址：GITEA_BASE_URL → config gitea.baseUrl → 默认内网地址。
// 令牌只放在请求头里，任何报错都不回显令牌。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEFAULT_BASE_URL = "http://106.54.199.229:3000"

export class GiteaApiError extends Error {
  constructor(message, { status = 0, code = "gitea_error", body = null, path = "" } = {}) {
    super(message)
    this.name = "GiteaApiError"
    Object.assign(this, { status, code, body, path })
  }
}

export function expandHome(p) {
  if (!p) return p
  const s = String(p)
  if (s === "~") return os.homedir()
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2))
  return s
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export function loadGiteaSettings({ env = process.env, configPath = "" } = {}) {
  const file = expandHome(configPath) || expandHome("~/.foreman/config.json")
  const cfg = readJson(file)?.gitea ?? {}
  const baseUrl = String(env.GITEA_BASE_URL || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")

  const files = [env.GITEA_TOKEN_FILE, cfg.tokenFile, "~/.foreman/gitea-token", "~/.config/gitea/token"]
    .filter(Boolean)
    .map(expandHome)

  let token = String(env.GITEA_TOKEN ?? "").trim()
  let tokenSource = token ? "env:GITEA_TOKEN" : ""
  if (!token) {
    for (const f of files) {
      try {
        const value = fs.readFileSync(f, "utf8").trim()
        if (value) {
          token = value
          tokenSource = f
          break
        }
      } catch {}
    }
  }
  if (!token && cfg.token) {
    token = String(cfg.token).trim()
    tokenSource = `${file}#gitea.token`
  }
  return { baseUrl, token, tokenSource, configPath: file, tokenFile: files[0] ?? "" }
}

export function requireToken(settings) {
  if (settings.token) return settings
  throw new GiteaApiError(
    `缺少 Gitea 访问令牌：请在 Gitea「设置 → 应用 → 管理 Access Token」生成（至少 issue / repository / organization 读写），` +
      `写入 ${expandHome("~/.foreman/gitea-token")}（chmod 600），或设置 GITEA_TOKEN。`,
    { code: "auth_required" },
  )
}

function buildUrl(baseUrl, pathname, query) {
  const url = new URL(`${baseUrl}${pathname}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item))
    } else {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

// request：一个出口做鉴权、超时、错误归一。body 为普通对象时按 JSON 提交，
// 需要上传文件时调用方直接传 FormData（Content-Type 交给 fetch 自己带 boundary）。
export async function request(
  pathname,
  { method = "GET", query, body, settings, timeout = 30000, fetchImpl = globalThis.fetch } = {},
) {
  const s = requireToken(settings ?? loadGiteaSettings())
  const url = buildUrl(s.baseUrl, pathname, query)
  const headers = { authorization: `token ${s.token}`, accept: "application/json" }

  let payload
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers["content-type"] = "application/json"
    payload = JSON.stringify(body)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let resp
  try {
    resp = await fetchImpl(url, { method, headers, body: payload, signal: controller.signal })
  } catch (e) {
    const code = e?.name === "AbortError" ? "timeout" : "network_error"
    throw new GiteaApiError(`请求 Gitea 失败（${method} ${url.pathname}）：${e?.message ?? e}`, {
      code,
      path: url.pathname,
    })
  } finally {
    clearTimeout(timer)
  }

  const text = await resp.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!resp.ok) {
    const message =
      (data && typeof data === "object" && (data.message || data.error)) ||
      (typeof data === "string" ? data.slice(0, 300) : "") ||
      resp.statusText
    const code =
      resp.status === 401
        ? "auth_required"
        : resp.status === 403
          ? "forbidden"
          : resp.status === 404
            ? "not_found"
            : resp.status === 405 || resp.status === 409 || resp.status === 422
              ? "conflict"
              : "gitea_error"
    const hint = code === "auth_required" ? "（令牌无效或已过期，重新生成后写入 ~/.foreman/gitea-token）" : ""
    throw new GiteaApiError(`Gitea ${method} ${url.pathname} 失败：HTTP ${resp.status} ${message}${hint}`, {
      status: resp.status,
      code,
      body: data,
      path: url.pathname,
    })
  }
  return data
}

export async function ping({ settings, fetchImpl } = {}) {
  return request("/api/v1/version", { settings, fetchImpl })
}
