import { test } from "node:test"
import assert from "node:assert/strict"
import { matchTask } from "../src/sessions.mjs"
import { selfConvIds } from "../src/util.mjs"

const tasks = [
  { id: "38453052825833730", title: "委派Gitea工单" },
  { id: "38452709939491842", title: "本地Linux沙盒模式实现" },
  { id: "38453099753059330", title: "接工单 yyzl/win-ai-harness#245 处理要求" },
  { id: "38453099753059331", title: "接工单 yyzl/win-ai-harness#246 处理要求" },
]

test("按标题精确匹配到任务 id", () => {
  assert.equal(matchTask(tasks, "委派Gitea工单").id, "38453052825833730")
})

test("标题唯一包含也能匹配", () => {
  assert.equal(matchTask(tasks, "沙盒").id, "38452709939491842")
})

test("包含匹配命中多条时不猜，返回 null", () => {
  assert.equal(matchTask(tasks, "接工单"), null)
})

test("找不到返回 null", () => {
  assert.equal(matchTask(tasks, "不存在的会话"), null)
})

test("空标题与空列表都返回 null", () => {
  assert.equal(matchTask(tasks, ""), null)
  assert.equal(matchTask([], "委派Gitea工单"), null)
})

test("没有 title 字段的任务不会误命中", () => {
  assert.equal(matchTask([{ id: "12345678" }], "委派Gitea工单"), null)
})

test("从环境里认出发命令的会话自己", () => {
  assert.deepEqual(selfConvIds({ MCP_VM_CONVERSATION_ID: "38453052825833730" }), ["38453052825833730"])
})

test("环境变量缺失或格式不对时返回空列表，不做自我拦截", () => {
  assert.deepEqual(selfConvIds({}), [])
  assert.deepEqual(selfConvIds({ MCP_VM_CONVERSATION_ID: "abc" }), [])
})

test("多个来源都给 id 时按顺序都收下", () => {
  assert.deepEqual(
    selfConvIds({ DWS_SELF_CONV_ID: "12345678", MCP_VM_CONVERSATION_ID: "23456789" }),
    ["12345678", "23456789"]
  )
})
