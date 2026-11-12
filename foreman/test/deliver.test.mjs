// 投递口径：不再塞回已有会话，默认每次新建一条会话（首句 = 固定提示词 + 监控项目 + 正文）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  deliveryMode,
  readFixedPrompt,
  deliverNewSession,
  notifyDecision,
} from "../src/service.mjs"
import { deliverPrompt, noticeSessionName } from "../src/prompts.mjs"
import { prWatchOnce } from "../src/prwatch.mjs"
import { Book } from "../src/book.mjs"
import { startServer } from "../src/service.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-deliver-"))
}

function cfgWith(dir, over = {}) {
  return {
    stateFile: path.join(dir, "state.json"),
    prWatch: { enabled: true, intervalSeconds: 300, state: "open", maxPages: 3, ignoreAuthors: [], notifyTarget: "earliest" },
    repos: [{ name: "demo", repo: "demo/demo", dir: path.join(dir, "repo"), base: "sit-20261126" }],
    ...over,
  }
}

test("deliveryMode：手搓 cfg 缺 deliver 时保持旧行为（existing）", () => {
  assert.equal(deliveryMode({}), "existing")
  assert.equal(deliveryMode({ deliver: {} }), "existing")
  assert.equal(deliveryMode({ deliver: { mode: "new" } }), "new")
  assert.equal(deliveryMode({ deliver: { mode: "NEW" } }), "new")
  assert.equal(deliveryMode({ deliver: { mode: "existing" } }), "existing")
})

test("readFixedPrompt：路径只从配置来，缺了/读不到/空文件都直接报错", () => {
  const dir = tmpDir()
  try {
    assert.throws(() => readFixedPrompt({}), /deliver\.promptFile/)
    const missing = path.join(dir, "nope.md")
    assert.throws(() => readFixedPrompt({ deliver: { promptFile: missing } }), /读不到固定提示词/)
    const empty = path.join(dir, "empty.md")
    fs.writeFileSync(empty, "  \n")
    assert.throws(() => readFixedPrompt({ deliver: { promptFile: empty } }), /空文件/)
    const ok = path.join(dir, "ok.md")
    fs.writeFileSync(ok, "# 工作原则\n- 不阻塞\n")
    assert.match(readFixedPrompt({ deliver: { promptFile: ok } }), /不阻塞/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("deliverPrompt：编排提示词原文在前，只给编排决策，不派实现任务", () => {
  const fixed = "# 工作原则\n1. 不阻塞"
  const text = "【foreman】demo/demo#2 状态：done"
  const out = deliverPrompt({ fixed, projectDir: "/w/win-ai-stack", kind: "工单结论", text, running: 1, maxRunning: 2, lane: "dispatch" })
  assert.match(out, /^# 工作原则/)
  assert.match(out, /1\. 不阻塞/)
  assert.match(out, /监控项目：\/w\/win-ai-stack/)
  assert.match(out, /触发：工单结论/)
  // 派单会话带通道与在跑数；合并会话走另一条通道，只有并发说明、不带在跑数。
  assert.match(out, /通道：派单（在跑 1 \/ 上限 2）/)
  assert.match(deliverPrompt({ fixed, kind: "合并完成", text, lane: "merge" }), /通道：合并（1 并发，只管合 PR）/)
  assert.ok(!deliverPrompt({ fixed, kind: "合并完成", text, lane: "merge" }).includes("在上限"))
  assert.match(out, /【foreman】demo\/demo#2 状态：done/)
  // 角色与三条路只在编排提示词（MD）里说一遍，组装层不复述，避免同一段身份说明出现两次。
  assert.match(out, /按上面的编排提示词做决定，不要亲手实现工单/)
  assert.match(out, /不是派给你的实现任务/)
  assert.ok(!out.includes("你的角色是编排者，不是这张工单的执行者"))
  assert.ok(!out.includes("由你决定下一步"))
  // 不能再写成「本次要处理的内容」（那样 AI 会把它当工单去做）。
  assert.ok(!out.includes("下面是本次要处理的内容"))
  // 没给项目/类型/在跑数也要能拼出来
  assert.match(deliverPrompt({ fixed, text: "只有正文" }), /只有正文/)
  assert.throws(() => deliverPrompt({ fixed: "  ", text: "x" }), /固定提示词为空/)
})

test("noticeSessionName：前缀 + 投递类型 + 本地时间戳", () => {
  const at = new Date(2026, 10, 12, 9, 5)
  assert.equal(noticeSessionName({ prefix: "foreman", kind: "工单结论", at }), "foreman-工单结论-20261112-0905")
  assert.equal(noticeSessionName({ prefix: "foreman", at }), "foreman-20261112-0905")
  assert.equal(noticeSessionName({ prefix: "", kind: "", at }), "foreman-20261112-0905")
})

test("deliverNewSession：新建一条会话投递，记账留痕但不进监听", async () => {
  const dir = tmpDir()
  try {
    const promptFile = path.join(dir, "fixed.md")
    fs.writeFileSync(promptFile, "# 固定提示词\n")
    const cfg = cfgWith(dir, { deliver: { mode: "new", promptFile, projectDir: "/w/win-ai-stack", namePrefix: "foreman" } })
    const calls = []
    const dws = { openNew: async (arg) => { calls.push(arg); return { convId: "conv-new" } } }
    const out = await deliverNewSession({ cfg, dws, log: () => {} }, { text: "【foreman】结论", kind: "工单结论" })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].noWait, true, "默认只确认送达，不等第一轮回复")
    // 结论走派单会话：命名带「派单」，通道也是派单。
    assert.match(calls[0].name, /^foreman-派单-/)
    assert.match(calls[0].prompt, /# 固定提示词/)
    assert.match(calls[0].prompt, /监控项目：\/w\/win-ai-stack/)
    assert.match(calls[0].prompt, /通道：派单（在跑 0 \/ 上限 2）/)
    assert.match(calls[0].prompt, /【foreman】结论/)
    assert.equal(out.convId, "conv-new")
    assert.equal(out.lane, "dispatch")

    const book = new Book(cfg.stateFile)
    const sess = book.session(calls[0].name)
    assert.equal(sess.convId, "conv-new")
    assert.equal(sess.kind, "deliver:dispatch")
    assert.equal(sess.notify, false, "投递会话不纳入监听，避免自己通知自己")
    assert.equal(book.watch.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("deliverNewSession：合并会话走自己的提示词、自己的命名，不占派单那条通道", async () => {
  const dir = tmpDir()
  try {
    const promptFile = path.join(dir, "dispatch.md")
    const mergePromptFile = path.join(dir, "merge.md")
    fs.writeFileSync(promptFile, "# 派单提示词\n只管接单与续跑\n")
    fs.writeFileSync(mergePromptFile, "# 合并提示词\n只管合 PR\n")
    const cfg = cfgWith(dir, {
      deliver: { mode: "new", promptFile, mergePromptFile, projectDir: "/w/win-ai-stack", namePrefix: "foreman" },
    })
    const calls = []
    const dws = { openNew: async (arg) => { calls.push(arg); return { convId: "conv-merge" } } }
    const out = await deliverNewSession({ cfg, dws, log: () => {} }, { text: "【foreman】PR 待合并", kind: "合并完成", lane: "merge" })

    assert.match(calls[0].name, /^foreman-合并-/)
    assert.match(calls[0].prompt, /只管合 PR/)
    assert.ok(!calls[0].prompt.includes("只管接单与续跑"), "合并会话不读派单提示词")
    assert.match(calls[0].prompt, /通道：合并/)
    assert.equal(out.lane, "merge")
    const book = new Book(cfg.stateFile)
    assert.equal(book.session(calls[0].name).kind, "deliver:merge")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("deliverNewSession：固定提示词没配好就报错，不静默降级", async () => {
  const dir = tmpDir()
  try {
    const cfg = cfgWith(dir, { deliver: { mode: "new" } })
    const dws = { openNew: async () => { throw new Error("不该走到开会话") } }
    await assert.rejects(() => deliverNewSession({ cfg, dws, log: () => {} }, { text: "x" }), /deliver\.promptFile/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("notifyDecision：new 模式不要求通知目标，也不会被判成 self", () => {
  const watcher = { target: "conv-work", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "" }
  const result = { status: "done", summary: "做完了" }

  // new：目标为空（也没有 MCP_VM_CONVERSATION_ID）照样要发——投递到新会话。
  const cfgNew = { notify: { enabled: true, session: "auto", events: ["done"] }, deliver: { mode: "new" } }
  const nd = notifyDecision({ cfg: cfgNew, watcher, book: {}, env: {}, result })
  assert.equal(nd.send, true)
  assert.match(nd.text, /状态：done/)

  // existing：同样条件按老口径不发（no-target）。
  const cfgOld = { notify: { enabled: true, session: "auto", events: ["done"] } }
  assert.equal(notifyDecision({ cfg: cfgOld, watcher, book: {}, env: {}, result }).reason, "no-target")
})

test("prWatchOnce：给了 deliver 就新建会话投递，不再通知已有会话", async () => {
  const dir = tmpDir()
  try {
    const cfg = cfgWith(dir, { deliver: { mode: "new", promptFile: path.join(dir, "fixed.md") } })
    fs.writeFileSync(cfg.deliver.promptFile, "# 固定提示词\n")
    new Book(cfg.stateFile).record("caller-1", { convId: "conv-first" })
    const gitea = { listPulls: async () => [{ repo: "demo/demo", number: 2, title: "别人的", author: "zhangsan", url: "http://x/pulls/2" }] }
    let notified = 0
    const dws = { notify: async () => { notified++ } }
    const delivered = []
    const deliver = async ({ text, kind }) => { delivered.push({ text, kind }); return { session: "foreman-PR待合并-20261112-0905", convId: "conv-new" } }

    const r = await prWatchOnce({ cfg, gitea, dws, log: () => {}, deliver })
    assert.equal(r.notified, 1)
    assert.equal(r.via, "new-session")
    assert.equal(notified, 0, "不该再往已有会话里塞消息")
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].text, /demo\/demo#2/)
    assert.equal(delivered[0].kind, "PR待合并")

    const seen = new Book(cfg.stateFile).prSeen
    assert.equal(seen["demo/demo#2"].notifiedTo, "foreman-PR待合并-20261112-0905")
    assert.equal(seen["demo/demo#2"].via, "new-session")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("端到端：deliver.mode=new 时 poll 跑完就新建会话投递，不碰已有会话", async () => {
  const dir = tmpDir()
  let server
  try {
    const promptFile = path.join(dir, "fixed.md")
    fs.writeFileSync(promptFile, "# 固定提示词\n")
    const cfg = {
      stateFile: path.join(dir, "state.json"),
      worktreeDir: path.join(dir, "worktrees"),
      pollSeconds: 20,
      timeoutMinutes: 90,
      maxAttempts: 3,
      perRepoPerRound: 1,
      pickup: { labelIds: [], labels: [], excludeLabels: [], onlyUnassigned: false, order: "oldest" },
      herdr: { bin: "herdr", enabled: false },
      merge: { enabled: false },
      notify: { enabled: true, session: "boss", events: ["done"] },
      prWatch: { enabled: false },
      deliver: { mode: "new", promptFile, projectDir: "/w/win-ai-stack", namePrefix: "foreman", waitFirstReply: false },
      service: {
        http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
        pidFile: path.join(dir, "foreman.pid"),
        logFile: path.join(dir, "service.log"),
        handshakeTimeoutMs: 500,
        stopTimeoutMs: 500,
      },
      repos: [],
    }
    const book = new Book(cfg.stateFile)
    book.setWatch({ target: "conv-e2e", name: "w", issueKey: "demo/demo#1", repo: "demo/demo", number: 1, notifyTo: "boss" })

    const notified = []
    const opened = []
    const dws = {
      status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
      info: async () => ({ lastReply: '<RESULT>{"status":"done","summary":"做完了"}</RESULT>' }),
      notify: async (target, text) => notified.push({ target, text }),
      openNew: async (arg) => {
        opened.push(arg)
        return { convId: "conv-deliver" }
      },
    }

    server = await startServer({ cfg, book, dws, log: () => {} })
    const r = await server.poll()
    assert.equal(r.notified, 1)
    assert.equal(notified.length, 0, "不再往已有会话里塞")
    assert.equal(opened.length, 1)
    assert.equal(opened[0].noWait, true)
    assert.match(opened[0].name, /^foreman-派单-/)
    assert.match(opened[0].prompt, /# 固定提示词/)
    assert.match(opened[0].prompt, /监控项目：\/w\/win-ai-stack/)
    assert.match(opened[0].prompt, /【foreman】demo\/demo #1/)

    const b2 = new Book(cfg.stateFile)
    assert.equal(b2.session(opened[0].name).notify, false, "投递会话不纳入监听")
    assert.match(b2.notified["conv-e2e"].fingerprint, /^[0-9a-f]{12}$/, "发成功后记账，指纹落库")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
