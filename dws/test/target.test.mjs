import { test } from "node:test"
import assert from "node:assert/strict"
import { matchTask } from "../src/sessions.mjs"

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
