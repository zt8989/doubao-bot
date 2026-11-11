// 配置：./foreman.json → ~/.foreman/config.json；未知键忽略不报错（升级友好）。
import fs from "node:fs"
import path from "node:path"
import { expandHome } from "./util.mjs"

export const DEFAULT_EXCLUDE = ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"]

export const DEFAULTS = {
  stateFile: "state.json",
  worktreeDir: "~/.foreman/worktrees",
  dws: { bin: "dws", mode: "local", model: "auto" },
  herdr: { bin: "herdr", enabled: true },
  pollSeconds: 20,
  timeoutMinutes: 90,
  maxAttempts: 3,
  perRepoPerRound: 2,
  pickup: {
    // labelIds 走服务端过滤：opencli 的列表接口不返回 labels，只按名字过滤会静默捞 0 条。
    labelIds: [],
    labels: [],
    excludeLabels: [...DEFAULT_EXCLUDE],
    onlyUnassigned: true,
    order: "oldest",
  },
  merge: { enabled: false, style: "merge", deleteBranch: true },
  // 收口通知：每条工单处理完，用 dws send 把结果回给「调用方会话」。
  // session 写 "auto" 就取环境变量 MCP_VM_CONVERSATION_ID（在豆包会话里跑 foreman 时就是那条会话），
  // 也可以直接写会话 id 或侧边栏标题。
  notify: {
    enabled: true,
    session: "auto",
    events: ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"],
  },
  repos: [],
}

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v)
}

function merge(base, over) {
  if (!isObj(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  }
  return out
}

export function resolveConfigPath(explicit) {
  if (explicit && explicit !== true) return expandHome(explicit)
  const local = path.resolve("foreman.json")
  if (fs.existsSync(local)) return local
  return expandHome("~/.foreman/config.json")
}

export function normalizeRepos(cfg) {
  return (cfg.repos ?? []).map((r) => {
    if (!r || typeof r === "string") throw new Error(`repos 里每一项要是对象：{"repo":"owner/name",...}`)
    if (!r.repo || !/^[^/\s]+\/[^/\s]+$/.test(r.repo)) throw new Error(`repos[].repo 要是 owner/name：${r.repo}`)
    if (!r.dir) throw new Error(`repos[].dir 必填（本地 clone 路径）：${r.repo}`)
    return {
      name: r.name || r.repo.split("/")[1],
      repo: r.repo,
      dir: expandHome(r.dir),
      base: r.base || "dev",
      verify: r.verify ?? [],
      labels: r.labels ?? null,
    }
  })
}

export function loadConfig(explicit) {
  const file = resolveConfigPath(explicit)
  let user = {}
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch (e) {
      throw new Error(`配置文件不是合法 JSON：${file}（${e.message}）`)
    }
  }
  const cfg = merge(DEFAULTS, user)
  cfg.configPath = fs.existsSync(file) ? file : ""
  for (const key of ["pollSeconds", "timeoutMinutes", "maxAttempts", "perRepoPerRound"]) {
    const n = Number(cfg[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 ${key} 要是正数，现在是：${cfg[key]}`)
    cfg[key] = n
  }
  cfg.repos = normalizeRepos(cfg)
  cfg.stateFile = expandHome(
    path.isAbsolute(cfg.stateFile) ? cfg.stateFile : path.join(path.dirname(file), cfg.stateFile)
  )
  if (!path.isAbsolute(cfg.stateFile)) cfg.stateFile = path.resolve(cfg.stateFile)
  return cfg
}
