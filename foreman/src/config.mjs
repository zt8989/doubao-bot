// 配置：./foreman.json → ~/.foreman/config.json；未知键忽略不报错（升级友好）。
import fs from "node:fs"
import path from "node:path"
import { expandHome } from "./util.mjs"
import { validateCron } from "./cron.mjs"

export const DEFAULT_EXCLUDE = ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"]

export const DEFAULTS = {
  stateFile: "state.json",
  worktreeDir: "~/.foreman/worktrees",
  dws: { bin: "dws", mode: "local", model: "auto" },
  herdr: { bin: "herdr", enabled: true },
  // Gitea REST：baseUrl 用于控制台拼链接；令牌实际由 gitea 包按 ~/.foreman/gitea-token 解析。
  gitea: { baseUrl: "http://106.54.199.229:3000", tokenFile: "~/.foreman/gitea-token" },
  pollSeconds: 20,
  timeoutMinutes: 90,
  maxAttempts: 3,
  perRepoPerRound: 2,
  pickup: {
    // labelIds 走服务端过滤：REST 的列表接口按 label id 过滤，名字过滤会静默捞 0 条。
    labelIds: [],
    labels: [],
    excludeLabels: [...DEFAULT_EXCLUDE],
    onlyUnassigned: false,
    // 接单优先级三档：我的（作者是我）→ 无人认领 → 他人。改数组即可调整先后。
    // 自己的 Gitea 用户名：从配置文件读（pickup.me），不在代码里写死；留空时用 prWatch.ignoreAuthors[0]。
    me: "",
    priority: ["mine", "unassigned", "others"],
    order: "oldest",
    // 自动巡检接单：服务在工作时间窗（workHours）里每 intervalSeconds 自动跑一轮捞单，
    // 不用人手敲 foreman run。默认关，显式 auto:true 才起。
    auto: false,
    intervalSeconds: 1800,
    // 一轮最多派几条（默认跟着容量走，一轮就能把空槽补满）。
    maxPerRound: 2,
    // 定时巡检同时在跑的单数上限：到顶就不再自动捞新单，等有单出结论。
    // 只约束 pickupOnce；agent 主动调 dispatch 不读这个上限。派活动作本身仍串行。
    maxRunning: 2,
    // 保守开关：有被监听会话在跑时不派新会话（老行为）。默认关，
    // 关掉才能同时有 2 张单在跑；豆包窗口互相抢时再打开。
    pauseWhileRunning: false,
    // 一张单收口（合并关单 / 手动完成 / clean 收尾）就立刻补下一张，不等自动巡检的 cron。
    // 只补一轮，容量（maxRunning）、工作时间窗、run 锁、节点暂停照旧把关；
    // 想退回「只在 cron 点巡检」就在配置里写 false。
    kickAfterDone: true,
    // 自动巡检每张工单先新建自己的编排会话（首句含编排职责与工单），由它调 foreman dispatch 分配工作。
    // 设 false（或 CLI 带 --direct）退回老行为：run 自己建工作区、开工作会话。
    handToOrchestrator: true,
  },
  // 工单会话中心：自动巡检每张工单各起一条编排会话，工作会话绑定这张单的编排。
  // 用户从当前会话主动派单时直接绑定当前会话；后续状态更新都 steer 到单上绑定的编排。
  // PR 扫描不受这里控制，deliver.mode=new 时始终新建合并会话。
  // enabled:false 退回老的多会话模型。
  sessionFlow: {
    enabled: true,
    // 会话名；留空用 `<deliver.namePrefix>-编排`。
    name: "",
    // 提示词：留空用内置 src/builtin/orchestrator-prompt.md；给了路径读不到直接报错。
    promptFile: "",
    // 写进首句的监控项目根目录；留空回落 deliver.projectDir。
    projectDir: "",
    // 只确认首句送达、不等回复（等回复会把服务轮询拖死）。
    waitFirstReply: false,
  },
  // 路由智能体：Foreman 只定时 queue 同一条会话，不自行收工或接单。
  // 24 小时连续未成功投递才新建路由会话；巡检不限制工作时间窗。
  router: {
    enabled: true,
    intervalSeconds: 600,
    recreateAfterHours: 24,
    projectDir: "",
  },
  // 合并通道：与派单通道独立排队，默认一次只合一条（合并要写账本，不能并发）。
  merge: {
    enabled: false,
    style: "merge",
    deleteBranch: true,
    concurrency: 1,
    intervalSeconds: 60,
    cron: "",
  },
  // 收口通知的配置位：保留语义，但 **notify 节点当前只落痕、不投递**（暂时不需要向谁通知）。
  // 恢复投递后：每条工单处理完用 dws send 回给「调用方会话」；session 写 "auto" 取
  // MCP_VM_CONVERSATION_ID（在豆包会话里跑 foreman 时就是那条会话），也可写会话 id 或侧边栏标题。
  notify: {
    enabled: true,
    session: "auto",
    // 同一条结果（同一指纹）最多发几次：首发 + 一次补偿。dws 偶发「消息到了却报
    // 发送失败」，不封顶就会每轮 poll 重发一遍，把调用方会话刷成重复通知。
    maxAttempts: 2,
    events: ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"],
  },
  // PR 监听：每 intervalSeconds 扫一遍各仓库 open PR；他人候选走合并助手分配，本人 UI 候选走验收指派。
  // 两类候选都只 queue 给router agent；显式 pr assign / pr ui-assign 后才执行对应写操作。
  prWatch: {
    enabled: true,
    intervalSeconds: 300,
    state: "open",
    maxPages: 3,
    // 自己的账号也在这里（跳过自己的 PR），loadConfig 会用 pickup.me 补齐。
    ignoreAuthors: [],
    // 本人 UI PR 的验收指派人：router agent执行 pr ui-assign 后按数组顺序轮询。
    // 每项 { name, username }；username 必须是真实 Gitea 登录名，配置不完整时不派。
    uiReviewers: [],
    notifyTarget: "earliest",
    // 默认过滤有冲突的 PR（合不了，报了没用）；设 false 则照报。
    filterConflicts: true,
  },
  // 邮件验收：PR 涉及 UI 时发信给测试同学，主题末尾带 [FM-<8位>] 筛选 ID；
  // 服务每 pollSeconds 轮询一次收件箱，把回复按筛选 ID 认回这张单，注回它的编排会话，
  // 收到「验收通过」就地合并（「驳回」保持 PR 打开）。
  // testers 先写占位符 <tester-1@example.com>：占位符不发信、也不挡合并；换成真邮箱后自动生效。
  mail: {
    enabled: false,
    bin: "agently-cli",
    testers: ["<tester-1@example.com>", "<tester-2@example.com>"],
    // round-robin：一次只发一位，按顺序轮着发（催办时换下一位）；all：两个一起发。
    strategy: "round-robin",
    subjectPrefix: "【foreman 验收】",
    scanLimit: 30,
    pollSeconds: 300,
    // 等这么久没回复就给另一位测试同学发催办；0 表示不催。
    remindMinutes: 120,
    maxReminders: 2,
    // UI 合并闸门：true 时，验收邮件发出去还在等回复的 PR 不许合并。
    uiGate: true,
    // 认 UI 改动的规则（正则字符串）；留空用代码里的默认（前端后缀 + 常见目录）。
    uiPatterns: [],
    // 白名单外的发件人回复一律忽略；留空 = 只认 testers。
    allowSenders: [],
    // 发信时带 --confirmed（foreman 自动发信，不可能走两阶段确认）。
    confirmed: true,
  },
  // 投递方式：结论/PR 不再塞回已有会话，默认每次新建一条豆包会话来接手。
  // mode=new 用 dws open 新开一条会话，首句 = 编排提示词（默认用代码内置的，配置给了路径才读那份运行时副本）+ 产品 + 监控项目 + 通知正文；
  // mode=existing 是旧行为（按 notify.session / prWatch.notifyTarget 找回已有会话塞消息）。
  // promptFile 留空就用内置提示词（src/builtin/*.md）；路径给了但文件不存在直接报错。
  deliver: {
    mode: "new",
    // 派单会话的提示词（续跑 / 接单 / 判合并）；留空用内置。
    promptFile: "",
    // 合并会话的提示词（判可合性）；留空用内置。
    mergePromptFile: "",
    // 监控项目根目录：写进新会话首句，不出现在代码里。
    projectDir: "",
    namePrefix: "foreman",
    // 新建会话只确认首句送达，不等第一轮回复（等回复会把服务轮询拖死）。
    waitFirstReply: false,
  },
  // 产品分组：一个产品一套仓库 + 自己的提示词 + 自己的监控项目根目录。
  // 配了 products 就以它为准（顶层 repos 只在没配 products 时用，老配置不用改）。
  // products[].promptFile / projectDir 留空时回落到顶层 deliver 的同名配置。
  products: [],
  // Always-on：Schedule / Inbox / Worker 同在 foreman serve 进程；写入后直接 wake，轮询只兜底。
  inbox: {
    pollMs: 1000,
    schedulePollMs: 1000,
    retrySeconds: 30,
    leaseSeconds: 900,
  },
  outbox: {
    pollMs: 1000,
    retrySeconds: 30,
    leaseSeconds: 120,
    maxAttempts: 8,
  },
  // Always-on 记忆：核心文件启动时注入；日记只按需检索。超限只拒绝写入，不自动精简。
  memory: {
    dir: "memory",
    maxEntryChars: 240,
    memoryMaxBytes: 4000,
    userMaxBytes: 2000,
    dreaming: { enabled: true, cron: "0 3 * * *" },
  },
  lark: { bin: "lark-cli", as: "user" },
  // 定时检查的工作时间窗：只在工作日 8:30–18:30 跑轮询（enabled:false 或整段省略 = 全天跑）。
  // offUntil 是临时闭嘴时间点，到点自动恢复。
  workHours: { enabled: false, days: [1, 2, 3, 4, 5], start: "08:30", end: "18:30", offUntil: "" },
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
    if (!r.base) throw new Error(`repos[].base 必填（基线分支写在配置里，代码不写死）：${r.repo}`)
    return {
      name: r.name || r.repo.split("/")[1],
      repo: r.repo,
      dir: expandHome(r.dir),
      // 基线分支必须由配置给（repos[].base），不再默认 dev/sit。
      base: r.base || "",
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
  const normalizedUser = !isObj(user.router) && isObj(user.inspector) ? { ...user, router: user.inspector } : user
  const cfg = merge(DEFAULTS, normalizedUser)
  // 旧 inspector 配置只作内存别名；新配置与公开文案使用 router。
  cfg.inspector = cfg.router
  cfg.configPath = fs.existsSync(file) ? file : ""
  for (const key of ["pollSeconds", "timeoutMinutes", "maxAttempts", "perRepoPerRound"]) {
    const n = Number(cfg[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 ${key} 要是正数，现在是：${cfg[key]}`)
    cfg[key] = n
  }
  for (const key of ["intervalSeconds", "recreateAfterHours"]) {
    const n = Number(cfg.router[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 router.${key} 要是正数，现在是：${cfg.router[key]}`)
    cfg.router[key] = n
  }
  cfg.repos = normalizeRepos(cfg)
  for (const key of ["pollMs", "retrySeconds", "leaseSeconds", "maxAttempts"]) {
    const n = Number(cfg.outbox[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 outbox.${key} 要是正数，现在是：${cfg.outbox[key]}`)
    cfg.outbox[key] = n
  }
  cfg.lark.bin = String(cfg.lark.bin || "lark-cli").trim()
  cfg.lark.as = String(cfg.lark.as || "user").trim()
  if (!["user", "bot"].includes(cfg.lark.as)) throw new Error(`配置项 lark.as 只支持 user|bot，现在是：${cfg.lark.as}`)
  // 身份（自己的 Gitea 账号）与基线都从配置来：me 与 ignoreAuthors 互相补齐，缺了就留空。
  const me = String(cfg.pickup?.me ?? "").trim() || String((cfg.prWatch?.ignoreAuthors ?? []).map(String).find((x) => x.trim()) ?? "").trim()
  if (me) {
    cfg.pickup.me = me
    const ignore = new Set((cfg.prWatch.ignoreAuthors ?? []).map((x) => String(x).trim()).filter(Boolean))
    ignore.add(me)
    cfg.prWatch.ignoreAuthors = [...ignore]
  }
  cfg.prWatch.ignoreAuthors = (cfg.prWatch.ignoreAuthors ?? []).map((x) => String(x).trim()).filter(Boolean)
  // 先展开 ~ 再判绝对路径：反过来会把 "~/x" 当成相对路径拼成 "<dir>/~/x"。
  cfg.stateFile = expandHome(cfg.stateFile)
  if (!path.isAbsolute(cfg.stateFile)) cfg.stateFile = path.resolve(path.dirname(file), cfg.stateFile)

  // 服务三路径：同 stateFile 的解析规则（~ 展开；相对路径落到配置文件同目录）。
  const baseDir = fs.existsSync(file) ? path.dirname(file) : process.cwd()

  // 记忆目录按配置文件解析；长度上限必须为正数，避免 NaN 让写入校验静默失效。
  cfg.memory = isObj(cfg.memory) ? cfg.memory : {}
  const rawMemoryDir = expandHome(String(cfg.memory.dir ?? "memory").trim() || "memory")
  cfg.memory.dir = path.isAbsolute(rawMemoryDir) ? rawMemoryDir : path.resolve(baseDir, rawMemoryDir)
  for (const key of ["maxEntryChars", "memoryMaxBytes", "userMaxBytes"]) {
    const n = Number(cfg.memory[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 memory.${key} 要是正数，现在是：${cfg.memory[key]}`)
    cfg.memory[key] = Math.floor(n)
  }
  cfg.memory.dreaming = isObj(cfg.memory.dreaming) ? cfg.memory.dreaming : { enabled: cfg.memory.dreaming !== false }
  cfg.memory.dreaming.enabled = cfg.memory.dreaming.enabled !== false
  const dreamingCron = validateCron(cfg.memory.dreaming.cron ?? "0 3 * * *")
  if (!dreamingCron.ok) throw new Error(`配置项 memory.dreaming.cron 不合法：${dreamingCron.error}`)
  cfg.memory.dreaming.cron = dreamingCron.expression

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
  // 自动接单巡检：开关只认 true，间隔、每轮条数与在跑上限都要正数。
  cfg.pickup.auto = cfg.pickup.auto === true
  cfg.pickup.pauseWhileRunning = cfg.pickup.pauseWhileRunning === true
  // 默认把捞到的单交给编排会话（以会话为中心）；显式 false 才自己派。
  cfg.pickup.handToOrchestrator = cfg.pickup.handToOrchestrator !== false
  for (const key of ["intervalSeconds", "maxPerRound", "maxRunning"]) {
    const n = Number(cfg.pickup[key])
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 pickup.${key} 要是正数，现在是：${cfg.pickup[key]}`)
    cfg.pickup[key] = Math.floor(n)
  }

  // 合并通道：并发与扫队列间隔要正数；并发默认 1，合并按顺序来。
  cfg.merge = cfg.merge && typeof cfg.merge === "object" ? cfg.merge : {}
  for (const key of ["concurrency", "intervalSeconds"]) {
    const n = Number(cfg.merge[key] ?? (key === "concurrency" ? 1 : 60))
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 merge.${key} 要是正数，现在是：${cfg.merge[key]}`)
    cfg.merge[key] = Math.floor(n)
  }

  const pwState = String(cfg.prWatch.state ?? "open")
  if (!["open", "closed", "all"].includes(pwState)) throw new Error(`配置项 prWatch.state 只能是 open/closed/all，现在是：${pwState}`)
  cfg.prWatch.state = pwState
  cfg.prWatch.uiReviewers = (Array.isArray(cfg.prWatch.uiReviewers) ? cfg.prWatch.uiReviewers : [])
    .map((x) => typeof x === "string"
      ? { name: x.trim(), username: x.trim() }
      : { name: String(x?.name ?? x?.username ?? "").trim(), username: String(x?.username ?? "").trim() })
    .filter((x) => x.name || x.username)

  // 邮件验收：占位符（<tester-1@example.com>）允许留在配置里；数值与策略写错直接报错。
  cfg.mail = cfg.mail && typeof cfg.mail === "object" ? cfg.mail : {}
  cfg.mail.enabled = cfg.mail.enabled === true
  cfg.mail.uiGate = cfg.mail.uiGate !== false
  cfg.mail.confirmed = cfg.mail.confirmed !== false
  cfg.mail.bin = String(cfg.mail.bin ?? "agently-cli").trim() || "agently-cli"
  cfg.mail.subjectPrefix = String(cfg.mail.subjectPrefix ?? "【foreman 验收】").trim() || "【foreman 验收】"
  cfg.mail.since = String(cfg.mail.since ?? "").trim()
  if (cfg.mail.since && !Number.isFinite(Date.parse(cfg.mail.since))) {
    throw new Error(`配置项 mail.since 要是合法的固定日期时间，现在是：${cfg.mail.since}`)
  }
  const mStrategy = String(cfg.mail.strategy ?? "round-robin").trim().toLowerCase()
  if (!["round-robin", "all"].includes(mStrategy)) {
    throw new Error(`配置项 mail.strategy 只能是 round-robin/all，现在是：${cfg.mail.strategy}`)
  }
  cfg.mail.strategy = mStrategy
  for (const key of ["pollSeconds", "scanLimit"]) {
    const n = Number(cfg.mail[key] ?? (key === "pollSeconds" ? 300 : 30))
    if (!Number.isFinite(n) || n <= 0) throw new Error(`配置项 mail.${key} 要是正数，现在是：${cfg.mail[key]}`)
    cfg.mail[key] = Math.floor(n)
  }
  for (const key of ["remindMinutes", "maxReminders"]) {
    const n = Number(cfg.mail[key] ?? (key === "remindMinutes" ? 120 : 2))
    if (!Number.isFinite(n) || n < 0) throw new Error(`配置项 mail.${key} 要是 0 或正数，现在是：${cfg.mail[key]}`)
    cfg.mail[key] = Math.floor(n)
  }
  cfg.mail.testers = (Array.isArray(cfg.mail.testers) ? cfg.mail.testers : [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
  cfg.mail.allowSenders = (Array.isArray(cfg.mail.allowSenders) ? cfg.mail.allowSenders : [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
  cfg.mail.uiPatterns = (Array.isArray(cfg.mail.uiPatterns) ? cfg.mail.uiPatterns : [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
  for (const p of cfg.mail.uiPatterns) {
    try {
      new RegExp(p, "i")
    } catch (e) {
      throw new Error(`配置项 mail.uiPatterns 里的正则不合法：${p}（${e.message}）`)
    }
  }

  // 投递：mode 只认 new/existing；promptFile / projectDir 按 stateFile 的规则展开（~ 与相对路径）。
  cfg.deliver = cfg.deliver && typeof cfg.deliver === "object" ? cfg.deliver : {}
  const dMode = String(cfg.deliver.mode ?? "new").trim().toLowerCase()
  if (!["new", "existing"].includes(dMode)) {
    throw new Error(`配置项 deliver.mode 只能是 new/existing，现在是：${cfg.deliver.mode}`)
  }
  cfg.deliver.mode = dMode
  for (const key of ["promptFile", "mergePromptFile", "projectDir"]) {
    const raw = expandHome(String(cfg.deliver[key] ?? "").trim())
    cfg.deliver[key] = raw ? (path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw)) : ""
  }
  if (dMode === "new" && cfg.deliver.promptFile && !fs.existsSync(cfg.deliver.promptFile)) {
    throw new Error(`配置项 deliver.promptFile 指向的固定提示词不存在：${cfg.deliver.promptFile}`)
  }
  if (dMode === "new" && cfg.deliver.mergePromptFile && !fs.existsSync(cfg.deliver.mergePromptFile)) {
    throw new Error(`配置项 deliver.mergePromptFile 指向的固定提示词不存在：${cfg.deliver.mergePromptFile}`)
  }
  cfg.deliver.namePrefix = String(cfg.deliver.namePrefix ?? "").trim() || "foreman"
  cfg.deliver.waitFirstReply = cfg.deliver.waitFirstReply === true

  // 编排会话：路径按 stateFile 的规则展开；提示词给了就要存在（不悄悄退回内置）。
  cfg.sessionFlow = cfg.sessionFlow && typeof cfg.sessionFlow === "object" ? cfg.sessionFlow : {}
  cfg.sessionFlow.enabled = cfg.sessionFlow.enabled !== false
  cfg.sessionFlow.name = String(cfg.sessionFlow.name ?? "").trim()
  cfg.sessionFlow.waitFirstReply = cfg.sessionFlow.waitFirstReply === true
  for (const key of ["promptFile", "projectDir"]) {
    const raw = expandHome(String(cfg.sessionFlow[key] ?? "").trim())
    cfg.sessionFlow[key] = raw ? (path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw)) : ""
  }
  if (cfg.sessionFlow.promptFile && !fs.existsSync(cfg.sessionFlow.promptFile)) {
    throw new Error(`配置项 sessionFlow.promptFile 指向的编排提示词不存在：${cfg.sessionFlow.promptFile}`)
  }

  // dws 可执行文件：常驻服务的 PATH 不一定有 dws，建议在配置里写绝对路径（支持 ~）。
  cfg.dws = cfg.dws && typeof cfg.dws === "object" ? cfg.dws : {}
  cfg.dws.bin = expandHome(String(cfg.dws.bin ?? "dws").trim()) || "dws"

  // 产品分组：每个产品 = 一套 repos + 自己的 promptFile / projectDir（留空回落顶层 deliver）。
  // cfg.repos 一律摊平成产品仓库的并集，后续捞单/PR 扫描不用区分来源。
  cfg.products = normalizeProducts(cfg, baseDir)
  if (cfg.products.length) {
    cfg.repos = cfg.products.flatMap((p) => p.repos)
  }
  return cfg
}

// normalizeProducts：把 products[] 归一成 {name, promptFile, projectDir, repos}。
// 每条 repoCfg 额外带 product 名，投递时好按仓库找回属于哪个产品。
function normalizeProducts(cfg, baseDir) {
  const list = Array.isArray(cfg.products) ? cfg.products : []
  return list.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`products[${i}] 要是对象：{"name":"…","repos":[…]}`)
    const name = String(p.name ?? "").trim()
    if (!name) throw new Error(`products[${i}].name 必填（产品名，用于分组与投递会话命名）`)
    const promptFileRaw = expandHome(String(p.promptFile ?? "").trim())
    const mergePromptRaw = expandHome(String(p.mergePromptFile ?? "").trim())
    const projectDirRaw = expandHome(String(p.projectDir ?? "").trim())
    const promptFile = promptFileRaw
      ? path.isAbsolute(promptFileRaw) ? promptFileRaw : path.resolve(baseDir, promptFileRaw)
      : ""
    const mergePromptFile = mergePromptRaw
      ? path.isAbsolute(mergePromptRaw) ? mergePromptRaw : path.resolve(baseDir, mergePromptRaw)
      : ""
    const projectDir = projectDirRaw
      ? path.isAbsolute(projectDirRaw) ? projectDirRaw : path.resolve(baseDir, projectDirRaw)
      : ""
    if (cfg.deliver.mode === "new" && promptFile && !fs.existsSync(promptFile)) {
      throw new Error(`products[${i}]（${name}）的 promptFile 指向的固定提示词不存在：${promptFile}`)
    }
    if (cfg.deliver.mode === "new" && mergePromptFile && !fs.existsSync(mergePromptFile)) {
      throw new Error(`products[${i}]（${name}）的 mergePromptFile 指向的提示词不存在：${mergePromptFile}`)
    }
    const repos = normalizeRepos(p).map((r) => ({ ...r, product: name }))
    if (!repos.length) throw new Error(`products[${i}]（${name}）至少要给一条 repos`)
    return { name, promptFile, mergePromptFile, projectDir, repos }
  })
}
