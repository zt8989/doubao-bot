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

test("readFixedPrompt：配置没给路径就用内置提示词；给了路径读不到/空文件仍然报错", () => {
  const dir = tmpDir()
  try {
    // 没配 promptFile：用代码内置的派单提示词（不再要求外部 md）。
    assert.match(readFixedPrompt({}), /派单会话提示词/)
    assert.match(readFixedPrompt({}), /不修改审查结论/)
    assert.match(readFixedPrompt({}), /对抗审查智能体/)
    assert.match(readFixedPrompt({}), /人类\/独立验收系统/)
    assert.match(readFixedPrompt({}, "", { lane: "merge" }), /合并助手/)
    assert.match(readFixedPrompt({}, "", { lane: "merge" }), /按通知给出的命令逐条合并/)
    assert.match(readFixedPrompt({}, "", { lane: "merge" }), /按回包内容直接汇报/)
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

test("内置主提示词包含两个内部 sub agent 的完整职责与提示词", () => {
  for (const name of ["router", "orchestrator", "dispatch", "merge"]) {
    const prompt = fs.readFileSync(new URL(`../src/builtin/${name}-prompt.md`, import.meta.url), "utf8")
    assert.match(prompt, /## 职责/, `${name} 缺少职责说明`)
    assert.match(prompt, /## 技能调用时机/, `${name} 缺少技能调用时机`)
    assert.doesNotMatch(prompt, /每\s*\d+\s*分钟|定时任务|定时器|Schedule|cron/i, `${name} 不应描述具体定时任务`)
    if (["orchestrator", "dispatch"].includes(name)) {
      assert.match(prompt, /主智能体：创建工单、分配任务、监听 PR 事件、触发对抗审查、汇总审查结果、发邮件通知验收、维护状态机/, `${name} 主智能体职责不一致`)
      assert.match(prompt, /不切分支、不提 PR、不合并、不修改审查结论、不代写代码/, `${name} 主智能体边界不一致`)
      assert.match(prompt, /编码智能体：创建分支、提交代码、发起 PR、填写 PR 模板、关联工单、附测试结果；按审查意见修复/, `${name} 编码智能体职责不一致`)
      assert.match(prompt, /只允许推送到非保护分支，不合并 PR/, `${name} 编码智能体边界不一致`)
      assert.match(prompt, /对抗审查智能体：只读 PR diff、工单验收标准和测试结果，输出结构化问题与阻断\/非阻断结论/, `${name} 审查智能体职责不一致`)
      assert.match(prompt, /不能改代码、不能提 PR、不能合并/, `${name} 审查智能体边界不一致`)
      assert.match(prompt, /人类\/独立验收系统：最终验收与合并。保护分支要求人工批准和 CI 通过/, `${name} 验收职责不一致`)
      assert.match(prompt, /编码 sub agent 和对抗审查 sub agent 都是当前 Agent 的内部 sub agent/, `${name} 未明确内部 sub agent 边界`)
      assert.match(prompt, /## 编码 sub agent 提示词/, `${name} 缺少编码 sub agent 提示词`)
      assert.match(prompt, /## 对抗审查 sub agent 提示词/, `${name} 缺少对抗审查 sub agent 提示词`)
      assert.match(prompt, /不得用 `foreman dispatch` 或 `foreman resume`/, `${name} 仍允许 Foreman 分配内部角色`)
      assert.match(prompt, /不得用 `dws` 为它们创建独立会话/, `${name} 仍允许 dws 创建内部角色`)
      assert.match(prompt, /foreman ws add/, `${name} 编码提示词缺少工作区职责`)
      assert.match(prompt, /foreman pr open/, `${name} 编码提示词缺少 PR 职责`)
      assert.match(prompt, /"conclusion": "blocking|non_blocking"/, `${name} 缺少结构化审查结论`)
      assert.match(prompt, /有阻断时把审查原文发回同一个编码 sub agent/, `${name} 缺少修复复审闭环`)
    }
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
  // 派单会话只描述当前职责与在跑数，不带定时任务配置；合并会话走另一条通道。
  assert.match(out, /通道：内部 sub agent（主智能体直接创建编码与审查；当前在跑 1）/)
  assert.doesNotMatch(out, /定时巡检上限|定时任务/)
  assert.match(deliverPrompt({ fixed, kind: "合并完成", text, lane: "merge" }), /通道：合并（1 并发，只管合 PR）/)
  assert.ok(!deliverPrompt({ fixed, kind: "合并完成", text, lane: "merge" }).includes("在上限"))
  assert.match(out, /【foreman】demo\/demo#2 状态：done/)
  // 角色与三条路只在编排提示词（MD）里说一遍，组装层不复述，避免同一段身份说明出现两次。
  assert.match(out, /实现交给内部编码 sub agent/)
  assert.match(out, /通道：内部 sub agent/)
  assert.doesNotMatch(out, /agent 主动派单/)
  assert.match(out, /不是派给你的实现任务/)
  assert.ok(!out.includes("你的角色是编排者，不是这张工单的执行者"))
  assert.ok(!out.includes("由你决定下一步"))
  // 不能再写成「本次要处理的内容」（那样 AI 会把它当工单去做）。
  assert.ok(!out.includes("下面是本次要处理的内容"))
  // 没给项目/类型/在跑数也要能拼出来
  assert.match(deliverPrompt({ fixed, text: "只有正文" }), /只有正文/)
  // 没给固定提示词 = 用内置的（派单/合并各一份），不再报「固定提示词为空」。
  assert.match(deliverPrompt({ fixed: "  ", text: "x" }), /派单会话提示词/)
  assert.match(deliverPrompt({ text: "x", lane: "merge" }), /合并助手/)
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
    assert.match(calls[0].prompt, /通道：内部 sub agent（主智能体直接创建编码与审查；当前在跑 0）/)
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

test("deliverNewSession：没配固定提示词就用内置的，照常开会话", async () => {
  const dir = tmpDir()
  try {
    const cfg = cfgWith(dir, { deliver: { mode: "new", projectDir: "/w/win-ai-stack" } })
    const calls = []
    const dws = { openNew: async (arg) => { calls.push(arg); return { convId: "conv-builtin" } } }
    const out = await deliverNewSession({ cfg, dws, log: () => {} }, { text: "【foreman】结论", kind: "工单结论" })

    assert.equal(calls.length, 1)
    assert.match(calls[0].prompt, /派单会话提示词/)
    assert.match(calls[0].prompt, /不修改审查结论/)
    assert.match(calls[0].prompt, /监控项目：\/w\/win-ai-stack/)
    assert.equal(out.convId, "conv-builtin")
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
    assert.equal(r.via, "merge-direct")
    assert.equal(notified, 0, "不该再往已有会话里塞消息")
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].text, /demo\/demo#2/)
    assert.equal(delivered[0].kind, "PR待合并")

    const seen = new Book(cfg.stateFile).prSeen
    assert.equal(seen["demo/demo#2"].notifiedTo, "foreman-PR待合并-20261112-0905")
    assert.equal(seen["demo/demo#2"].via, "merge-assistant")
    assert.equal(seen["demo/demo#2"].assignedTo, "foreman-PR待合并-20261112-0905")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("端到端：任务回复只 queue 给所属 Agent，不走 deliver.new 或旧 notify", async () => {
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
      runningMap: async () => ({ "conv-e2e": { running: false } }),
      status: async () => ({ streaming: false, finished: true, chars: 500, head: "H", tail: "T", status: "ok" }),
      info: async () => ({ lastReply: "做完了，已提交并通过测试。" }),
      queue: async (target, text) => notified.push({ target, text }),
      notify: async () => { throw new Error("旧 notify 不应参与任务状态投递") },
      openNew: async (arg) => {
        opened.push(arg)
        return { convId: "conv-deliver" }
      },
    }

    server = await startServer({ cfg, book, dws, log: () => {} })
    const r = await server.poll()
    assert.equal(r.notified, 0)
    await server.worker.idle()
    await server.worker.runOnce()
    assert.equal(notified.length, 1, "Worker queue 给所属 Agent")
    assert.equal(notified[0].target, "boss")
    assert.equal(opened.length, 0, "不走 deliver.new 新建派单会话")

    const b2 = new Book(cfg.stateFile)
    assert.match(b2.notified["conv-e2e"].fingerprint, /^[0-9a-f]{12}$/, "节点照样落痕，指纹落库")
  } finally {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
