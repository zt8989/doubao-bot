// 邮件验收：筛选 ID、回复判定、轮转发信、按 ID 认回、注回会话、合并闸门。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  acceptTagFor,
  parseAcceptTag,
  tagMarker,
  isPlaceholderEmail,
  realRecipients,
  htmlToText,
  stripQuoted,
  parseVerdict,
  summarizeReply,
} from "../src/mail.mjs"
import {
  uiFilesChanged,
  requestAcceptance,
  requestOf,
  mailPollOnce,
  acceptanceGate,
  applyVerdict,
  sessionTargetFor,
} from "../src/mailflow.mjs"
import { Book } from "../src/book.mjs"
import { loadConfig } from "../src/config.mjs"

const tmpState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-mail-"))
  return path.join(dir, "state.json")
}

const baseCfg = (mailOver = {}) => ({
  stateFile: tmpState(),
  mail: {
    enabled: true,
    testers: ["tester-a@corp.test", "tester-b@corp.test"],
    strategy: "round-robin",
    subjectPrefix: "【foreman 验收】",
    scanLimit: 30,
    pollSeconds: 300,
    remindMinutes: 0,
    maxReminders: 0,
    uiGate: true,
    uiPatterns: [],
    allowSenders: [],
    confirmed: true,
    bin: "agently-cli",
    ...mailOver,
  },
})

// 假驱动：只记调用，不碰真邮箱。
function fakeDriver({ list = [], bodies = {} } = {}) {
  const calls = { send: [], list: 0, read: [] }
  return {
    calls,
    async send(msg) {
      calls.send.push(msg)
      return { queued: true }
    },
    async list() {
      calls.list++
      return { data: list }
    },
    async read(id) {
      calls.read.push(id)
      return { body: bodies[id] ?? "" }
    },
    async me() {
      return { email: "agent@corp.test", aliases: [] }
    },
  }
}

test("筛选 ID：按 repo#pr 稳定生成，回复主题能认回来，不认别的工具的标记", () => {
  const a = acceptTagFor("demo/web", 12)
  assert.equal(a, acceptTagFor("demo/web", 12))
  assert.match(a, /^FM-[0-9a-f]{8}$/)
  assert.notEqual(a, acceptTagFor("demo/web", 13))
  assert.equal(parseAcceptTag(`【foreman 验收】demo/web#12 改按钮 ${tagMarker(a)}`), a.toLowerCase())
  assert.equal(parseAcceptTag(`Re: 【foreman 验收】demo/web#12 改按钮 [${a}]`), a.toLowerCase())
  assert.equal(parseAcceptTag("Re: [AM:s=conv-1|t=abc] 你好"), "", "别的工具的筛选 ID 不要混进来")
  assert.equal(parseAcceptTag("没有标记"), "")
})

test("收件人：占位符去掉，真邮箱去重", () => {
  assert.equal(isPlaceholderEmail("<tester-1@example.com>"), true)
  assert.equal(isPlaceholderEmail(""), true)
  assert.equal(isPlaceholderEmail("not-an-email"), true)
  assert.equal(isPlaceholderEmail("a@b.co"), false)
  const cfg = {
    mail: { testers: ["<tester-1@example.com>", "A@x.com", "a@x.com", "b@y.com", " "] },
  }
  // 大小写不敏感去重，保留第一次出现的写法。
  assert.deepEqual(realRecipients(cfg), ["A@x.com", "b@y.com"])
})

test("正文转纯文本：去标签、解实体、块级换行", () => {
  const text = htmlToText('<div>验收&nbsp;<b>通过</b></div><div>谢谢</div><script>x()</script>')
  assert.match(text, /验收 通过/)
  assert.match(text, /谢谢/)
  assert.equal(text.includes("<b>"), false)
  assert.equal(text.includes("x()"), false)
})

test("回复判定：通过 / 驳回 / 没有问题不算驳回 / 引用原文不参与判定", () => {
  assert.equal(parseVerdict("看过了，验收通过 ✅"), "approved")
  assert.equal(parseVerdict("没有问题，可以合并"), "approved")
  assert.equal(parseVerdict("LGTM"), "approved")
  assert.equal(parseVerdict("验收不通过：按钮错位"), "rejected")
  assert.equal(parseVerdict("驳回：登录页白屏"), "rejected")
  assert.equal(parseVerdict("有问题，先别合"), "rejected")
  // 引用里带着我们自己的说明（含「驳回」「验收通过」），不能被当成本人表态。
  const quoted = [
    "还没看",
    "",
    "在 2026-11-18，foreman <agent@corp.test> 写道：",
    "> · 验收通过 → 正文写「验收通过」",
    "> · 不通过 → 正文写「驳回：具体问题」",
  ].join("\n")
  assert.equal(parseVerdict(quoted), "unknown")
  assert.equal(parseVerdict("> 验收通过"), "unknown", "整段引用里没有本人表态")
  assert.equal(stripQuoted("通过了\n-----原始邮件-----"), "通过了")
})

test("摘要：压平空白并截断", () => {
  assert.equal(summarizeReply("<div>验收\n通过</div>", 10), "验收 通过")
  assert.equal(summarizeReply("a".repeat(50), 10), `${"a".repeat(10)}…`)
})

test("UI 文件识别：前端后缀与常见目录命中，文档不命中", () => {
  const hit = uiFilesChanged(["src/views/login.vue", "web/app.tsx", "src/lib/a.ts", "README.md"])
  assert.deepEqual(hit, ["src/views/login.vue", "web/app.tsx"])
  assert.deepEqual(uiFilesChanged(["src/a.ts"], ["(^|/)src/"]), ["src/a.ts"])
})

test("发验收邮件：占位符只记 no-recipient，不发信也不报错", async () => {
  const cfg = baseCfg({ testers: ["<tester-1@example.com>", "<tester-2@example.com>"] })
  const driver = fakeDriver()
  const r = await requestAcceptance({ cfg, mail: driver, log: () => {} }, { repo: "demo/web", pr: 7, url: "http://g/pull/7" })
  assert.equal(r.ok, false)
  assert.equal(r.skipped, "no-recipient")
  assert.equal(driver.calls.send.length, 0)
  const req = requestOf(new Book(cfg.stateFile), "demo/web", 7)
  assert.equal(req.status, "no-recipient")
  assert.match(req.tag, /^FM-/)
})

test("发验收邮件：轮转两个测试同学，主题带筛选 ID，重复调用不重发", async () => {
  const cfg = baseCfg()
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {} }
  const first = await requestAcceptance(ctx, { repo: "demo/web", pr: 12, url: "http://g/pull/12", issueKey: "demo/web#3", title: "改登录按钮" })
  assert.equal(first.ok, true)
  assert.equal(first.to, "tester-a@corp.test")
  assert.equal(driver.calls.send.length, 1)
  const sent = driver.calls.send[0]
  assert.equal(sent.to[0], "tester-a@corp.test")
  assert.match(sent.subject, /demo\/web#12/)
  assert.match(sent.subject, new RegExp(`\\[${first.tag}\\]`))
  assert.match(sent.body, /验收通过/)

  const again = await requestAcceptance(ctx, { repo: "demo/web", pr: 12 })
  assert.equal(again.skipped, "already-sent")
  assert.equal(driver.calls.send.length, 1)

  // force：换下一位测试同学，主题仍是同一个筛选 ID。
  const second = await requestAcceptance(ctx, { repo: "demo/web", pr: 12, force: true })
  assert.equal(second.ok, true)
  assert.equal(second.to, "tester-b@corp.test")
  assert.equal(driver.calls.send.length, 2)
  assert.match(driver.calls.send[1].subject, new RegExp(`\\[${first.tag}\\]`))
  const req = requestOf(new Book(cfg.stateFile), "demo/web", 12)
  assert.equal(req.status, "waiting")
  assert.equal(req.sentCount, 2)
  assert.deepEqual(req.tried, ["tester-a@corp.test", "tester-b@corp.test"])
})

test("发验收邮件：strategy=all 两个一起发；发信失败记 send-failed", async () => {
  const cfgAll = baseCfg({ strategy: "all" })
  const d1 = fakeDriver()
  await requestAcceptance({ cfg: cfgAll, mail: d1, log: () => {} }, { repo: "demo/web", pr: 1 })
  assert.deepEqual(d1.calls.send[0].to, ["tester-a@corp.test", "tester-b@corp.test"])

  const cfg = baseCfg()
  const bad = {
    calls: { send: [] },
    async send() {
      throw new Error("mail_cli：agently-cli 没授权")
    },
  }
  const r = await requestAcceptance({ cfg, mail: bad, log: () => {} }, { repo: "demo/web", pr: 2 })
  assert.equal(r.ok, false)
  assert.equal(r.skipped, "send-failed")
  const req = requestOf(new Book(cfg.stateFile), "demo/web", 2)
  assert.equal(req.status, "send-failed")
  assert.match(req.error, /没授权/)
})

test("收信：按筛选 ID 认回 PR，注回编排会话，通过后合并", async () => {
  const cfg = baseCfg()
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {}, session: { steers: [], async steer(id, text) { this.steers.push({ id, text }) } } }
  const merged = []
  ctx.merge = async (task) => {
    merged.push(task)
    return { ok: true, reason: "" }
  }
  const sent = await requestAcceptance(ctx, { repo: "demo/web", pr: 21, url: "http://g/pull/21", issueKey: "demo/web#9", title: "改样式" })
  const book = new Book(cfg.stateFile)
  book.setIssue("demo/web#9", { orchestrator: "conv-orch-9" })

  driver.list = async () => ({
    data: [
      {
        message_id: "msg_1",
        subject: `Re: 【foreman 验收】demo/web#21 改样式 [${sent.tag}]`,
        from: { email: "tester-a@corp.test", name: "测试A" },
        created_at: "2026-11-18T10:00:00Z",
        snippet: "验收通过",
      },
      { message_id: "msg_2", subject: "【foreman 验收】别的单 [" + sent.tag + "]", from: { email: "stranger@evil.test" }, snippet: "验收通过" },
      { message_id: "msg_3", subject: "Re: 周报", from: { email: "tester-a@corp.test" }, snippet: "验收通过" },
    ],
  })
  driver.read = async (id) => ({ body: id === "msg_1" ? "<div>看过了，验收通过</div><div>按钮位置对了</div>" : "<div>验收通过</div>" })

  // stranger 那条的 tag 是假的（不指向真实请求），会被当 orphan；这里先制造一个同 tag 请求给 stranger 试白名单。
  const out = await mailPollOnce(ctx)
  assert.equal(out.ok, true)
  assert.equal(out.matched, 1, "只有名单内的发件人才处理")
  assert.equal(out.verdicts, 1)
  assert.equal(out.steered, 1)
  assert.equal(out.merged, 1)

  const req = requestOf(new Book(cfg.stateFile), "demo/web", 21)
  assert.equal(req.status, "merged")
  assert.equal(req.replies.length, 1)
  assert.equal(req.replies[0].verdict, "approved")
  assert.match(req.replies[0].summary, /验收通过/)

  assert.equal(ctx.session.steers.length, 1)
  assert.equal(ctx.session.steers[0].id, "conv-orch-9")
  assert.match(ctx.session.steers[0].text, /邮件验收回复/)
  assert.match(ctx.session.steers[0].text, /验收通过/)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].approvedBy, "mail:tester-a@corp.test")
  assert.equal(merged[0].pr, 21)

  // 再轮一轮：同一封回复不重复处理。
  const again = await mailPollOnce(ctx)
  assert.equal(again.verdicts, 0)
  assert.equal(merged.length, 1)
})

test("收信：驳回只注回会话，不合并", async () => {
  const cfg = baseCfg()
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {}, session: { steers: [], async steer(id, text) { this.steers.push({ id, text }) } } }
  let mergeCalls = 0
  ctx.merge = async () => {
    mergeCalls++
    return { ok: true }
  }
  const sent = await requestAcceptance(ctx, { repo: "demo/web", pr: 31, issueKey: "demo/web#13", title: "改按钮" })
  new Book(cfg.stateFile).setIssue("demo/web#13", { orchestrator: "conv-13" })
  driver.list = async () => ({
    data: [
      {
        message_id: "msg_9",
        subject: `Re: [${sent.tag}]`,
        from: { email: "tester-b@corp.test" },
        snippet: "驳回：按钮错位",
      },
    ],
  })
  driver.read = async () => ({ body: "驳回：按钮在 375 宽错位了" })
  const out = await mailPollOnce(ctx)
  assert.equal(out.verdicts, 1)
  assert.equal(out.merged, 0)
  const req = requestOf(new Book(cfg.stateFile), "demo/web", 31)
  assert.equal(req.status, "rejected")
  assert.equal(mergeCalls, 0)
  assert.match(ctx.session.steers[0].text, /保持打开/)
  assert.equal(new Book(cfg.stateFile).approval("demo/web#31"), null)
})

test("合并闸门：没开邮件 / 不是 UI / 占位符都放行", async () => {
  const off = baseCfg({ enabled: false })
  assert.equal((await acceptanceGate({ cfg: off }, { repo: "demo/web", pr: 1 })).allow, true)

  const cfg = baseCfg()
  assert.equal((await acceptanceGate({ cfg, log: () => {} }, { repo: "demo/web", pr: 2 })).allow, true, "没发过验收就不是 UI 单")

  const ph = baseCfg({ testers: ["<tester-1@example.com>"] })
  const r = await acceptanceGate({ cfg: ph, mail: fakeDriver(), log: () => {} }, { repo: "demo/web", pr: 3, ui: true })
  assert.equal(r.allow, true)
  assert.equal(r.skipped, "no-recipient")
})

test("合并闸门：邮件已发出在等回复 → 不许合；通过后放行", async () => {
  const cfg = baseCfg()
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {} }
  await requestAcceptance(ctx, { repo: "demo/web", pr: 41, url: "http://g/pull/41", title: "改界面" })
  const denied = await acceptanceGate(ctx, { repo: "demo/web", pr: 41, ui: true })
  assert.equal(denied.allow, false)
  assert.equal(denied.reason, "acceptance-waiting")
  assert.match(denied.message, /tester-a@corp\.test/)

  new Book(cfg.stateFile).markApproval("demo/web#41", { by: "tester-a@corp.test", via: "mail" })
  const allowed = await acceptanceGate(ctx, { repo: "demo/web", pr: 41, ui: true })
  assert.equal(allowed.allow, true)
  assert.equal(allowed.via, "approved")
})

test("合并闸门：驳回挡住；带 --approved-by 放行并记批准", async () => {
  const cfg = baseCfg()
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {} }
  const sent = await requestAcceptance(ctx, { repo: "demo/web", pr: 51, title: "改界面" })
  const book = new Book(cfg.stateFile)
  book.markMailRequest("demo/web#51", { status: "rejected", lastVerdict: { verdict: "rejected", summary: "按钮错位" } })
  const rejected = await acceptanceGate(ctx, { repo: "demo/web", pr: 51, ui: true })
  assert.equal(rejected.allow, false)
  assert.equal(rejected.reason, "acceptance-rejected")
  assert.match(rejected.message, /按钮错位/)

  const flag = await acceptanceGate(ctx, { repo: "demo/web", pr: 51, ui: true, approvedBy: "周腾" })
  assert.equal(flag.allow, true)
  assert.equal(new Book(cfg.stateFile).approval("demo/web#51").by, "周腾")
  assert.equal(sent.tag, book.mail.requests["demo/web#51"].tag)
})

test("合并闸门：之前没真收件人，补上邮箱后第一次合并补发并开始等", async () => {
  const cfg = baseCfg({ testers: ["<tester-1@example.com>"] })
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {} }
  const first = await acceptanceGate(ctx, { repo: "demo/web", pr: 61, ui: true })
  assert.equal(first.allow, true)
  assert.equal(driver.calls.send.length, 0)

  cfg.mail.testers = ["tester-a@corp.test"]
  const second = await acceptanceGate(ctx, { repo: "demo/web", pr: 61, ui: true, url: "http://g/pull/61" })
  assert.equal(second.allow, false)
  assert.equal(second.reason, "acceptance-waiting")
  assert.equal(driver.calls.send.length, 1)
  assert.equal(requestOf(new Book(cfg.stateFile), "demo/web", 61).status, "waiting")
})

test("注回会话：没有编排会话时退到全局编排；都没有就只记账", async () => {
  const cfg = baseCfg()
  const driver = fakeDriver()
  const ctx = { cfg, mail: driver, log: () => {} }
  const book = new Book(cfg.stateFile)
  assert.equal(sessionTargetFor(book, "demo/web#1"), "")
  book.setOrchestrator?.({ convId: "conv-global" })
  assert.equal(sessionTargetFor(book, "demo/web#1"), "conv-global")

  const req = { repo: "demo/web", pr: 71, tag: acceptTagFor("demo/web", 71), url: "http://g/pull/71" }
  const applied = await applyVerdict(ctx, { req, from: "tester-a@corp.test", verdict: "approved", text: "验收通过" })
  assert.equal(applied.steered, false)
  assert.equal(requestOf(new Book(cfg.stateFile), "demo/web", 71).status, "approved")
  assert.equal(new Book(cfg.stateFile).approval("demo/web#71").via, "mail")
})

test("配置：mail 默认占位符能通过校验；策略/正则写错直接报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-mail-cfg-"))
  const file = path.join(dir, "foreman.json")
  const base = { repos: [{ repo: "a/b", dir: "/tmp", base: "sit-test" }] }
  fs.writeFileSync(file, JSON.stringify(base))
  const def = loadConfig(file)
  assert.equal(def.mail.enabled, false)
  assert.deepEqual(def.mail.testers, ["<tester-1@example.com>", "<tester-2@example.com>"])
  assert.equal(def.mail.strategy, "round-robin")
  assert.equal(realRecipients(def).length, 0, "占位符不算真收件人")

  const bad = path.join(dir, "bad.json")
  fs.writeFileSync(bad, JSON.stringify({ ...base, mail: { enabled: true, strategy: "broadcast" } }))
  assert.throws(() => loadConfig(bad), /mail\.strategy/)

  const badRe = path.join(dir, "bad-re.json")
  fs.writeFileSync(badRe, JSON.stringify({ ...base, mail: { uiPatterns: ["("] } }))
  assert.throws(() => loadConfig(badRe), /uiPatterns/)

  const ok = path.join(dir, "ok.json")
  fs.writeFileSync(ok, JSON.stringify({ ...base, mail: { enabled: true, testers: ["tester-a@corp.test"], uiPatterns: ["\\.vue$"] } }))
  const cfg = loadConfig(ok)
  assert.deepEqual(realRecipients(cfg), ["tester-a@corp.test"])
})
