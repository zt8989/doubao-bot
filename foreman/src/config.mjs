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
    // 同一条结果（同一指纹）最多发几次：首发 + 一次补偿。dws 偶发「消息到了却报
    // 发送失败」，不封顶就会每轮 poll 重发一遍，把调用方会话刷成重复通知。
    maxAttempts: 2,
    events: ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"],
  },
  // PR 监听：每 intervalSeconds 扫一遍各仓库 open PR，把作者不在 ignoreAuthors 里的单
  // 通知给「最早登记的调用方」；只通知不合并。默认 5 分钟一次。
  prWatch: {
    enabled: true,
    intervalSeconds: 300,
    state: "open",
    maxPages: 3,
    ignoreAuthors: ["233151"],
    notifyTarget: "earliest",
  },
  // 常驻服务：只有 HTTP 一条通道（CLI 的 RPC + 控制台页面同端口），按 pollSeconds 轮询。
  // pidFile/logFile 的相对路径解析到配置文件同目录；~ 展开。
  service: {
    enabled: true,
    pidFile: "~/.foreman/foreman.pid",
    logFile: "~/.foreman/service.log",
    handshakeTimeoutMs: 5000,
    stopTimeoutMs: 5000,
    // 唯一的通道：HTTP（CLI 的 RPC + 控制台同端口）；端口写到 portFile，CLI 读它连过来。
    http: {
      host: "127.0.0.1",
      port: 7317,
      portFile: "~/.foreman/service.port",
      db: "~/.foreman/console.db",
    },
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
  // 先展开 ~ 再判绝对路径：反过来会把 "~/x" 当成相对路径拼成 "<dir>/~/x"。
  cfg.stateFile = expandHome(cfg.stateFile)
  if (!path.isAbsolute(cfg.stateFile)) cfg.stateFile = path.resolve(path.dirname(file), cfg.stateFile)

  // 服务三路径：同 stateFile 的解析规则（~ 展开；相对路径落到配置文件同目录）。
  const baseDir = fs.existsSync(file) ? path.dirname(file) : process.cwd()
  for (const key of ["pidFile", "logFile"]) {
    const raw = expandHome(cfg.service[key])
    cfg.service[key] = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw)
  }
  for (const key of ["handshakeTimeoutMs", "stopTimeoutMs"]) {
    const n = Number(cfg.service[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 service.${key} 要是正数，现在是：${cfg.service[key]}`)
    cfg.service[key] = n
  }

  // 控制台 HTTP：端口 1–65535；db 路径按 stateFile 的规则展开（~ → 家目录）。
  cfg.service.http = cfg.service.http && typeof cfg.service.http === "object" ? cfg.service.http : {}
  const httpPort = Number(cfg.service.http.port ?? 7317)
  // 0 = 让系统分配端口（测试用；服务会把实际端口写进 portFile）。
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new Error(`配置项 service.http.port 要是 0–65535 的整数，现在是：${cfg.service.http.port}`)
  }
  cfg.service.http.port = httpPort
  cfg.service.http.host = String(cfg.service.http.host || "127.0.0.1")
  for (const key of ["db", "portFile"]) {
    const fallback = key === "db" ? "~/.foreman/console.db" : "~/.foreman/service.port"
    const raw = expandHome(String(cfg.service.http[key] || fallback))
    cfg.service.http[key] = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw)
  }

  // PR 监听：间隔与翻页上限要正数；状态只认 open/closed/all。
  for (const key of ["intervalSeconds", "maxPages"]) {
    const n = Number(cfg.prWatch[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 prWatch.${key} 要是正数，现在是：${cfg.prWatch[key]}`)
    cfg.prWatch[key] = n
  }
  const pwState = String(cfg.prWatch.state ?? "open")
  if (!["open", "closed", "all"].includes(pwState)) throw new Error(`配置项 prWatch.state 只能是 open/closed/all，现在是：${pwState}`)
  cfg.prWatch.state = pwState
  return cfg
}
