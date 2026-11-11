import test from "node:test"
import assert from "node:assert/strict"
import { NOTIFY_EVENTS, notifyTarget, shouldNotify, notifyText } from "../src/orchestrator.mjs"

test("notifyTarget：没配就用调用方会话 id（MCP_VM_CONVERSATION_ID）", () => {
  assert.equal(notifyTarget({ session: "auto" }, { MCP_VM_CONVERSATION_ID: "38453052825833730" }), "38453052825833730")
})

test("notifyTarget：auto 但没有环境变量时返回空串，不猜", () => {
  assert.equal(notifyTarget({ session: "auto" }, {}), "")
  assert.equal(notifyTarget({}, {}), "")
})

test("notifyTarget：显式会话 id 或标题优先于环境变量", () => {
  assert.equal(notifyTarget({ session: "委派Gitea工单" }, { MCP_VM_CONVERSATION_ID: "1" }), "委派Gitea工单")
})

test("notifyTarget：enabled=false 直接不通知", () => {
  assert.equal(notifyTarget({ enabled: false, session: "38453052825833730" }, {}), "")
})

test("shouldNotify：默认只在有结论的状态上通知", () => {
  assert.equal(shouldNotify({}, "done"), true)
  assert.equal(shouldNotify({}, "pr-open"), true)
  assert.equal(shouldNotify({}, "planned"), false)
  assert.equal(shouldNotify({}, "working"), false)
})

test("shouldNotify：可以自定义事件，enabled=false 全关", () => {
  assert.equal(shouldNotify({ events: ["done"] }, "failed"), false)
  assert.equal(shouldNotify({ events: ["done"] }, "done"), true)
  assert.equal(shouldNotify({ enabled: false }, "done"), false)
})

test("notifyText：一条单 + 结论 + PR 链接", () => {
  const text = notifyText(
    { repo: "yyzl/win-ai-harness", number: 250, title: "docs: authz.md 认证口径同步" },
    { state: "done", branch: "fix/issue-250", pr: 258, prUrl: "http://106.54.199.229:3000/yyzl/win-ai-harness/pulls/258" }
  )
  assert.match(text, /【foreman】yyzl\/win-ai-harness #250 docs: authz\.md 认证口径同步/)
  assert.match(text, /状态：done/)
  assert.match(text, /分支：fix\/issue-250/)
  assert.match(text, /PR：#258/)
  assert.match(text, /pulls\/258/)
})

test("notifyText：失败也要说清原因，长原因截断", () => {
  const text = notifyText({ repo: "yyzl/win-ai-harness", number: 251 }, { state: "failed", reason: "x".repeat(300) })
  assert.match(text, /状态：failed/)
  assert.ok(text.length < 300, "超长原因要被截断")
})

test("NOTIFY_EVENTS 覆盖 pr-open（不合并时停在 PR 也要通知）", () => {
  assert.ok(NOTIFY_EVENTS.includes("pr-open"))
})
