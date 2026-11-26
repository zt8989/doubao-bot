// 飞书 OAuth 设备授权流（RFC 8628，同 openclaw-lark 的做法）：
// start() 拿 device_code + verification_uri（链接）/ verification_uri_complete（渲染成二维码），
// 后台定时轮询 token 端点；用户扫码/点链接授权后换 user_access_token，
// 再用 token 读一次 user_info 拿 open_id + 名字——给私聊白名单用。
// token 用完即弃（出站走 lark-cli，不入库不存盘）。fetchFn 可注入（测试）。
// 独立于 feishu.mjs（SDK 长连接）：本文件纯 fetch 零依赖，服务常驻创建也不会加载 SDK。
const OAUTH_HOSTS = {
  feishu: { accounts: "https://accounts.feishu.cn", open: "https://open.feishu.cn" },
  lark: { accounts: "https://accounts.larksuite.com", open: "https://open.larksuite.com" },
}

export class FeishuAuth {
  constructor({ cfg, log = () => {}, fetchFn = null } = {}) {
    this.cfg = cfg
    this.log = log
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis)
    this.timer = null
    this.interval = 5
    this.flow = { status: "idle" }
  }

  feishuCfg() {
    return this.cfg.feishu ?? {}
  }

  view() {
    const flow = this.flow
    return {
      status: flow.status,
      userCode: flow.userCode ?? "",
      verificationUri: flow.verificationUri ?? "",
      verificationUriComplete: flow.verificationUriComplete ?? "",
      expiresAt: flow.expiresAt ?? "",
      openId: flow.openId ?? "",
      userName: flow.userName ?? "",
      error: flow.error ?? "",
    }
  }

  async start() {
    const fc = this.feishuCfg()
    if (!fc.appId || !fc.appSecret) throw new Error("飞书应用凭据未配置：在 config.json 的 feishu.appId/appSecret 里填一次（之后只用扫码授权）")
    const hosts = OAUTH_HOSTS[fc.domain === "lark" ? "lark" : "feishu"]
    const basic = Buffer.from(`${fc.appId}:${fc.appSecret}`).toString("base64")
    const body = new URLSearchParams({ client_id: fc.appId, scope: "offline_access contact:user.base:readonly" })
    const resp = await this.fetchFn(`${hosts.accounts}/oauth/v1/device_authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: body.toString(),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || data.error) {
      throw new Error(`发起授权失败：${data.error_description ?? data.error ?? `HTTP ${resp.status}`}`)
    }
    this.stop()
    this.interval = Number(data.interval ?? 5)
    this.flow = {
      status: "pending",
      deviceCode: String(data.device_code ?? ""),
      userCode: String(data.user_code ?? ""),
      verificationUri: String(data.verification_uri ?? ""),
      verificationUriComplete: String(data.verification_uri_complete ?? data.verification_uri ?? ""),
      expiresAt: new Date(Date.now() + Number(data.expires_in ?? 240) * 1000).toISOString(),
      error: "",
    }
    this.timer = setInterval(() => {
      this.check().catch((e) => {
        this.flow.status = "failed"
        this.flow.error = e.message
        this.stop()
      })
    }, this.interval * 1000)
    this.timer.unref?.()
    this.log(`飞书设备授权已发起：user_code=${this.flow.userCode}`)
    return this.view()
  }

  // 一轮 token 轮询；授权页未确认时安静返回，控制台照常拿 view() 轮询状态。
  async check() {
    const flow = this.flow
    if (flow.status !== "pending") return this.view()
    if (Date.parse(flow.expiresAt) < Date.now()) {
      flow.status = "expired"
      flow.error = "授权码已过期，请重新发起"
      this.stop()
      return this.view()
    }
    const fc = this.feishuCfg()
    const hosts = OAUTH_HOSTS[fc.domain === "lark" ? "lark" : "feishu"]
    const resp = await this.fetchFn(`${hosts.open}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: flow.deviceCode ?? "",
        client_id: fc.appId,
        client_secret: fc.appSecret,
      }).toString(),
    })
    const data = await resp.json().catch(() => ({}))
    if (data.access_token) {
      this.stop()
      const who = await this.whoAmI(String(data.access_token), hosts)
      this.flow = { ...flow, status: "authorized", ...who, error: "" }
      this.log(`飞书授权完成：${who.userName}（${who.openId}）`)
      return this.view()
    }
    if (data.error === "authorization_pending") return this.view()
    if (data.error === "slow_down") {
      this.interval = Math.min(this.interval + 5, 60)
      return this.view()
    }
    flow.status = "failed"
    flow.error = data.error_description ?? data.error ?? `HTTP ${resp.status}`
    this.stop()
    return this.view()
  }

  // 拿授权人身份：user_info 读 open_id + 名字，给白名单一键填入。
  async whoAmI(accessToken, hosts) {
    const resp = await this.fetchFn(`${hosts.open}/open-apis/authen/v1/user_info`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || (data.code !== undefined && data.code !== 0)) {
      return { openId: "", userName: "", error: `拿授权人身份失败：${data.msg ?? `HTTP ${resp.status}`}` }
    }
    return { openId: String(data.data?.open_id ?? ""), userName: String(data.data?.name ?? "") }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
