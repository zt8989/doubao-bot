// 飞书外发通道：只调用 lark-cli，不在 foreman 里实现 OpenAPI 或凭据管理。
import { exec, extractJson } from "./util.mjs"

export class LarkError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = "LarkError"
    this.code = extra.code ?? "lark_error"
    Object.assign(this, extra)
  }
}

export class LarkDriver {
  constructor({ bin = "lark-cli", as = "user", execFn = exec } = {}) {
    this.bin = bin
    this.as = as
    this.execFn = execFn
  }

  async run(args) {
    let r
    try {
      r = await this.execFn(this.bin, args, { timeout: 120000 })
    } catch (error) {
      throw new LarkError(`${this.bin} ${args.slice(0, 2).join(" ")} 失败：${String(error?.stderr || error?.message || error).slice(-600)}`, {
        code: "lark_cli", args,
      })
    }
    let env
    try {
      env = extractJson(r.stdout)
    } catch {
      throw new LarkError(`${this.bin} 输出不是 JSON：${String(r.stdout ?? "").slice(-500)}`, { code: "lark_bad_output", args })
    }
    if (env?.ok === false) {
      throw new LarkError(String(env?.error?.message ?? env?.error ?? "飞书接口返回失败"), { code: "lark_api", args, raw: env })
    }
    return env?.data ?? env ?? {}
  }

  async send({ chatId = "", userId = "", text = "", markdown = "", idempotencyKey = "" } = {}) {
    const chat = String(chatId ?? "").trim()
    const user = String(userId ?? "").trim()
    if (Boolean(chat) === Boolean(user)) throw new LarkError("chatId 与 userId 必须且只能提供一个", { code: "lark_bad_recipient" })
    const plain = String(text ?? "")
    const md = String(markdown ?? "")
    if (Boolean(plain.trim()) === Boolean(md.trim())) throw new LarkError("text 与 markdown 必须且只能提供一个", { code: "lark_bad_content" })
    const key = String(idempotencyKey ?? "").trim()
    if (key.length > 50) throw new LarkError("idempotencyKey 最长 50 字符", { code: "lark_bad_idempotency" })
    const args = ["im", "+messages-send", chat ? "--chat-id" : "--user-id", chat || user]
    if (plain.trim()) args.push("--text", plain)
    else args.push("--markdown", md)
    args.push("--as", this.as)
    if (key) args.push("--idempotency-key", key)
    return this.run(args)
  }
}
