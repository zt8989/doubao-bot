// 邮件通道：只走 agently-cli（QQ Agent Mail），foreman 不自己实现邮件协议。
// 这里只管「发 / 列 / 读 / 回」，主题里的筛选 ID、回复判定、注回会话都在 mailflow.mjs。
import crypto from "node:crypto"
import { exec, extractJson } from "./util.mjs"

export class MailError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = "MailError"
    this.code = extra.code ?? "mail_error"
    Object.assign(this, extra)
  }
}

// agently-cli 的退出码语义（见 agently-mail Skill）：3 授权失效、7 限频、8 缺确认令牌。
const EXIT_HINT = {
  2: "参数不合规",
  3: "授权失效：先跑 agently-cli auth login 重新授权",
  4: "本地网络错误",
  6: "业务永久拒绝（退订 / 黑名单 / 地址不存在）",
  7: "触发限频，稍后再试",
  8: "缺少 confirmation-token",
}

export function classifyMailError(e) {
  const out = String(e?.stderr ?? "").trim() || String(e?.message ?? e ?? "").trim()
  let hint = ""
  for (const [code, text] of Object.entries(EXIT_HINT)) {
    if (String(e?.message ?? "").includes(`退出码 ${code}`)) hint = text
  }
  if (/ENOENT|not found|找不到/i.test(out)) hint = "没有 agently-cli：npm i -g @tencent-qqmail/agently-cli && agently-cli auth login"
  return hint ? `${hint}（${out.slice(-400)}）` : out.slice(-600)
}

// 邮箱占位符：配置里先写 <tester-1@example.com>，真邮箱到了再替换；占位符不发信、不挡合并。
export function isPlaceholderEmail(value) {
  const s = String(value ?? "").trim()
  if (!s) return true
  if (/^<.*>$/.test(s)) return true
  return !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s)
}

// 真收件人：去掉占位符、空值、重复。
export function realRecipients(cfg) {
  const list = Array.isArray(cfg?.mail?.testers) ? cfg.mail.testers : []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const email = String(raw ?? "").trim()
    if (isPlaceholderEmail(email)) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(email)
  }
  return out
}

// 验收主题的筛选 ID：按 repo#pr 生成稳定短哈希，回复时邮件客户端会原样保留在主题里。
// 主题形如：`【foreman 验收】owner/repo#12 标题 [FM-ab12cd34]`
export function acceptTagFor(repo, pr) {
  const seed = `${String(repo ?? "").trim()}#${Number(pr ?? 0)}`
  return `FM-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8)}`
}

export function tagMarker(tag) {
  return `[${String(tag ?? "").trim()}]`
}

// 从主题里抠回筛选 ID；`Re: … [FM-ab12cd34]` 也能认。
// 只认 FM- 前缀：别把别的工具（例如 DSH Agent Mail 的 [AM:s=…]）的标记混进来。
export function parseAcceptTag(subject) {
  const m = /\[(FM-[0-9a-f]{8})\]/i.exec(String(subject ?? ""))
  return m ? m[1].toLowerCase() : ""
}

// 普通邮件的回复路由：主题保留会话 ID，Worker 才能 steer 回发起会话。
export function sessionRouteMarker(sessionId) {
  const id = String(sessionId ?? "").trim()
  if (!id) return ""
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("--session-id 只能包含字母、数字、下划线和连字符")
  return `[FM-SID:${id}]`
}

export function withSessionRoute(subject, sessionId) {
  const marker = sessionRouteMarker(sessionId)
  const base = String(subject ?? "").trim().replace(/\s*\[FM-SID:[A-Za-z0-9_-]+\]/gi, "").trim()
  return marker ? `${base} ${marker}` : base
}

export function parseSessionRoute(subject) {
  const m = /\[FM-SID:([A-Za-z0-9][A-Za-z0-9_-]{0,127})\]/i.exec(String(subject ?? ""))
  return m?.[1] ?? ""
}

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
}

// HTML 正文转纯文本（回复判定只认文字，不认标签）：去脚本/样式、块级标签换行、解常见实体。
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|tr|h[1-6]|table|tbody|ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|#39|#x27);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// 截掉引用部分：Foxmail 的「在 … 写道：」、Outlook 的 `>` 引用、`-----原始邮件-----`。
// 不截的话，我们自己在正文里写的「验收通过 / 驳回」说明会被当成对方的表态。
export function stripQuoted(text) {
  const lines = String(text ?? "").split("\n")
  const out = []
  for (const line of lines) {
    const s = line.trim()
    if (/^>/.test(s)) break
    if (/^(在|于)\s.{0,80}(写道|寫道)：/.test(s)) break
    if (/^on\s.{0,80}wrote:/i.test(s)) break
    if (/^-{2,}\s*(原始邮件|original message|转发邮件)/i.test(s)) break
    if (/^发件人[:：]/.test(s)) break
    out.push(line)
  }
  return out.join("\n").trim()
}

// 验收判定：先否定再肯定（「验收不通过」里也有「通过」）。
// 只认明确的表态词，缺省 unknown —— 不猜，留给编排会话/人去看原话。
const REJECT_RE = /(不通过|未通过|没通过|驳回|打回|不能合并|不可合并|(?<!没)有问题|有\s*bug|有缺陷|不行|拒绝|reject|changes\s*requested|request\s*changes)/i
const APPROVE_RE = /(验收通过|通过验收|验收\s*ok|可以合并|可合并|同意合并|同意合入|没问题|没有问题|已验收|验收ok|lgtm|approve|approved)/i

export function parseVerdict(text) {
  const body = stripQuoted(htmlToText(text)).slice(0, 2000)
  if (!body.trim()) return "unknown"
  if (REJECT_RE.test(body)) return "rejected"
  if (APPROVE_RE.test(body)) return "approved"
  return "unknown"
}

// 邮件驱动：每次调用都是一次子进程；错误统一转成 MailError（带可执行的下一步提示）。
export class MailDriver {
  constructor({ bin = "agently-cli", confirmed = true, log = () => {} } = {}) {
    this.bin = bin
    this.confirmed = confirmed !== false
    this.log = log
  }

  async run(args, { timeout = 60000 } = {}) {
    let r
    try {
      r = await exec(this.bin, args, { timeout })
    } catch (e) {
      throw new MailError(`${this.bin} ${args.slice(0, 2).join(" ")} 失败：${classifyMailError(e)}`, {
        code: "mail_cli",
        args,
      })
    }
    let env
    try {
      env = extractJson(r.stdout)
    } catch (e) {
      throw new MailError(`${this.bin} ${args[0]} 输出不是 JSON：${String(r.stdout ?? "").slice(-500)}`, {
        code: "mail_bad_output",
        args,
      })
    }
    if (env?.ok === false) {
      throw new MailError(String(env?.error?.message ?? env?.error ?? "邮件接口返回失败"), {
        code: "mail_api",
        args,
        raw: env,
      })
    }
    // 两阶段确认：带了 --confirmed 不该再拿到 token；真拿到了说明参数没传对，直接报出来。
    if (env?.data?.confirmation_required === true) {
      throw new MailError(`发信仍要求二次确认（缺 --confirmed）：${String(env?.data?.summary?.subject ?? "")}`, {
        code: "mail_confirm",
        raw: env,
      })
    }
    return env?.data ?? {}
  }

  async me() {
    const d = await this.run(["+me"])
    const primary = (d?.aliases ?? []).find((a) => a?.is_primary) ?? (d?.aliases ?? [])[0] ?? {}
    return { email: String(primary.email ?? ""), aliases: d?.aliases ?? [], limits: d?.rate_limits ?? {} }
  }

  async send({ to, subject, body }) {
    const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x ?? "").trim()).filter(Boolean)
    if (!recipients.length) throw new MailError("没有收件人", { code: "mail_bad_recipient" })
    if (!String(subject ?? "").trim()) throw new MailError("主题不能为空", { code: "mail_bad_subject" })
    const args = ["message", "+send"]
    for (const t of recipients) args.push("--to", t)
    args.push("--subject", String(subject), "--body", String(body ?? ""), "--body-format", "plain")
    if (this.confirmed) args.push("--confirmed")
    return this.run(args, { timeout: 120000 })
  }

  async list({ dir = "inbox", limit = 30, cursor = "", unread = false } = {}) {
    const args = ["message", "+list", "--dir", dir, "--limit", String(Math.max(1, Number(limit) || 30))]
    if (cursor) args.push("--cursor", String(cursor))
    if (unread) args.push("--is-unread")
    return this.run(args, { timeout: 60000 })
  }

  async search({ q, limit = 30 }) {
    return this.run(
      ["message", "+search", "--q", String(q), "--limit", String(Math.max(1, Number(limit) || 30))],
      { timeout: 60000 }
    )
  }

  async read(id) {
    const key = String(id ?? "").trim()
    if (!key) throw new MailError("读信要 message_id", { code: "mail_bad_id" })
    return this.run(["message", "+read", "--id", key], { timeout: 60000 })
  }

  async reply({ id, body }) {
    const args = ["message", "+reply", "--id", String(id), "--body", String(body ?? ""), "--body-format", "plain"]
    if (this.confirmed) args.push("--confirmed")
    return this.run(args, { timeout: 120000 })
  }
}

// 把回复正文压成一句可读的摘要（注回会话时用，别把整封 HTML 灌进去）。
export function summarizeReply(text, max = 220) {
  const flat = stripQuoted(htmlToText(text)).replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
