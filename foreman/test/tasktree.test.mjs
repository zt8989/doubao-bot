import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { formatSessionTasks, sessionTasks } from "../src/tasktree.mjs"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-tasktree-"))
  const stateFile = path.join(dir, "state.json")
  const book = new Book(stateFile)
  book.setIssue("yyzl/demo#1", { state: "working", orchestrator: "conv-orch", agent: "foreman-demo-1", agentConvId: "conv-worker" })
  book.setIssue("yyzl/demo#2", { state: "pr-open", orchestrator: "conv-user", agent: "foreman-demo-2", agentConvId: "conv-worker-2" })
  book.setIssue("yyzl/demo#3", { state: "failed", orchestrator: "conv-orch-3" })
  book.record("foreman-demo-1-编排", { convId: "conv-orch", kind: "orchestrator", role: "orchestrator", issueKey: "yyzl/demo#1", notify: false })
  book.record("foreman-demo-1", { convId: "conv-worker", kind: "worker", role: "worker", parent: "conv-orch", notify: true })
  book.record("foreman-merge", { convId: "conv-merge", kind: "deliver:merge", notify: false })
  book.record("old-deliver", { convId: "conv-old", kind: "deliver:merge", notify: false })
  book.markPrSeen("yyzl/demo#9", { repo: "yyzl/demo", number: 9, assignedTo: "foreman-merge", assignedConvId: "conv-merge", merged: false })
  book.setWatch({ target: "conv-review", name: "review-agent", issueKey: "yyzl/demo#1", parent: "conv-orch" })
  return { dir, stateFile }
}

function flatten(nodes, out = []) {
  for (const node of nodes) {
    out.push(node)
    flatten(node.children, out)
  }
  return out
}

test("tasks 以已分配会话为主体，按编排父会话展示编码与补派子树", async () => {
  const { dir, stateFile } = fixture()
  try {
    let statusCalls = 0
    const result = await sessionTasks({
      cfg: { stateFile },
      dws: {
        runningMap: async () => ({
          "conv-orch": { running: false, title: "编排一", active: true },
          "conv-worker": { running: true, title: "编码一", active: true },
          "conv-review": { running: false, title: "补派验收", active: false },
          "conv-worker-2": { running: false, title: "编码二", active: false },
          "conv-orch-3": { running: false, title: "编排三", active: false },
        }),
        status: async () => { statusCalls++ },
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.issues, undefined, "不再返回工单列表")
    assert.equal(result.summary.unresolvedIssues, 3)
    assert.equal(result.summary.prOpenIssues, 1)
    assert.equal(result.summary.runningWorkers, 1)
    assert.equal(statusCalls, 0, "只读侧边栏，不逐条 status 切窗口")

    const nodes = flatten(result.sessions)
    const orch = nodes.find((n) => n.convId === "conv-orch")
    assert.equal(orch.state, "idle")
    assert.equal(orch.roleName, "编排智能体")
    assert.deepEqual(orch.children.map((n) => n.convId), ["conv-worker", "conv-review"])
    assert.equal(orch.children[0].state, "running")
    assert.equal(orch.children[0].roleName, "编码智能体")
    assert.equal(orch.children[0].issueState, "working")
    assert.equal(orch.children[1].state, "idle")
    assert.equal(nodes.find((n) => n.convId === "conv-merge").state, "gone")
    assert.equal(nodes.find((n) => n.convId === "conv-merge").prKey, "yyzl/demo#9")
    assert.equal(nodes.find((n) => n.convId === "conv-old"), undefined, "省略无未收口关联的历史 gone 叶子")

    const text = formatSessionTasks(result)
    assert.match(text, /编排智能体/)
    assert.match(text, /编码智能体/)
    assert.match(text, /├─ .*conv-worker.*running/)
    assert.match(text, /└─ .*conv-review.*idle/)
    assert.doesNotMatch(text, /第 \d+ 次|卡在：/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("同一会话兼有 router 与编排职责时保留多重角色", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-tasktree-roles-"))
  try {
    const stateFile = path.join(dir, "state.json")
    const book = new Book(stateFile)
    book.record("foreman-router", { convId: "conv-shared", kind: "router", role: "router" })
    book.setIssue("yyzl/demo#4", { state: "pr-open", orchestrator: "conv-shared" })
    const result = await sessionTasks({
      cfg: { stateFile },
      dws: { runningMap: async () => ({ "conv-shared": { running: false } }) },
    })
    assert.deepEqual(result.sessions[0].roles, ["router", "orchestrator"])
    assert.match(result.sessions[0].roleName, /路由智能体/)
    assert.match(result.sessions[0].roleName, /编排智能体/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("DWS 状态不可用时明确 unknown，不回退成工单 working", async () => {
  const { dir, stateFile } = fixture()
  try {
    const result = await sessionTasks({
      cfg: { stateFile },
      dws: { runningMap: async () => { throw new Error("sidebar unavailable") } },
    })
    const nodes = flatten(result.sessions)
    assert.ok(nodes.length > 0)
    assert.ok(nodes.every((n) => n.state === "unknown" && n.running === null))
    assert.equal(result.summary.runningWorkers, 0)
    assert.match(result.statusError, /sidebar unavailable/)
    assert.match(formatSessionTasks(result), /状态未知/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
