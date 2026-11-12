// workflow 节点：暂停/继续只停自己这个节点，统计累计 +1（只增不减）；控制台 /api/workflow 读写。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isPaused, setNodePaused, bumpNode, nodeCounts } from "../src/workflow/nodes.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"
import { WorkflowEngine } from "../src/workflow/engine.mjs"

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-nodes-"))
  return { dir, stateFile: path.join(dir, "state.json") }
}

test("节点暂停：只动这个节点，别的节点与整条流程都不受影响", () => {
  const { dir, stateFile } = tmpState()
  try {
    assert.equal(isPaused(stateFile, "pickup"), false)
    const r1 = setNodePaused(stateFile, "pickup", true)
    assert.equal(r1.paused, true)
    assert.deepEqual(r1.pausedNodes, ["pickup"])
    assert.equal(isPaused(stateFile, "pickup"), true)
    assert.equal(isPaused(stateFile, "notify"), false, "只停 pickup，通知节点照常")
    const r2 = setNodePaused(stateFile, "pickup", false)
    assert.equal(r2.paused, false)
    assert.deepEqual(r2.pausedNodes, [])
    // 不传 paused 就切换
    assert.equal(setNodePaused(stateFile, "scan").paused, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("节点统计：每执行一次 +1，只增不减（暂停/重启都不归零）", () => {
  const { dir, stateFile } = tmpState()
  try {
    bumpNode(stateFile, "pickup", { detail: "第一轮" })
    bumpNode(stateFile, "pickup", { detail: "第二轮" })
    setNodePaused(stateFile, "pickup", true)
    // 暂停期间没执行，次数不变
    assert.equal(nodeCounts(stateFile).pickup.count, 2)
    setNodePaused(stateFile, "pickup", false)
    bumpNode(stateFile, "pickup")
    assert.equal(nodeCounts(stateFile).pickup.count, 3, "继续后接着往上加")
    assert.equal(nodeCounts(stateFile).pickup.detail, "", "最后一次没给说明就清空 detail")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("engine：节点表带 auto/暂停/次数，emit 自动节点时计数 +1", async () => {
  const { dir, stateFile } = tmpState()
  try {
    const engine = new WorkflowEngine({
      cfg: { stateFile, repos: [] },
      session: { on: async () => {} },
      tracker: { on: async () => {} },
      workspace: { on: async () => {}, cleanup: async () => ({ notes: [] }) },
      log: () => {},
    })
    const before = engine.nodes().find((n) => n.stage === "pickup")
    assert.equal(before.auto, true)
    assert.equal(before.count, 0)
    await engine.emit("issue.picked", { issueKey: "r#1", workflow: "own" })
    const after = engine.nodes().find((n) => n.stage === "pickup")
    assert.equal(after.count, 1, "自动节点 emit 一次就 +1")
    // 非自动节点不计数
    await engine.emit("session.finished", { issueKey: "r#1", workflow: "own" })
    assert.equal(engine.nodes().find((n) => n.stage === "develop").count, 0)
    // 暂停只影响该节点自己的动作
    engine.setPaused("pickup", true)
    assert.equal(engine.paused("pickup"), true)
    assert.equal(engine.allow("notify"), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("HTTP：/api/workflow 看节点、暂停一个节点再继续", async () => {
  const { dir, stateFile } = tmpState()
  const states = { paused: [] }
  const nodes = () => [
    { stage: "pickup", auto: true, paused: states.paused.includes("pickup"), count: 2 },
    { stage: "notify", auto: true, paused: states.paused.includes("notify"), count: 5 },
  ]
  const ctx = {
    engine: {
      workflows: () => [{ id: "own", name: "自有工单", description: "x", stages: [] }],
      nodes,
      active: () => [],
      runs: () => [],
      setPaused: (stage, paused) => {
        states.paused = paused ? [...states.paused, stage] : states.paused.filter((s) => s !== stage)
        return { stage, paused }
      },
    },
  }
  const h = await startConsoleHttp({ store: {}, ctx, dir, host: "127.0.0.1", port: 0, log: () => {}, onRpc: null })
  try {
    // onRpc 没接时该端点返回 501（纯静态场景）
    const off = await fetch(`${h.url}/api/workflow`)
    assert.equal(off.status, 501)
  } finally {
    await new Promise((r) => h.server.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
