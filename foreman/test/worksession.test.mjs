// foreman 亲自开编码/审查工作会话（router 编排协议 v2，替代 CreateSession）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openWorkSession } from "../src/sessionflow.mjs"
import { Book } from "../src/book.mjs"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-worksession-"))
  const repoDir = path.join(dir, "worktree")
  fs.mkdirSync(repoDir)
  const taskFile = path.join(dir, "task.md")
  fs.writeFileSync(taskFile, "工单：o/r#18\n验收：改完自测通过")
  const opened = []
  const ctx = {
    stateFile: path.join(dir, "state.json"),
    cfg: { stateFile: path.join(dir, "state.json") },
    state: { watchers: new Map() },
    log: () => {},
    session: {
      openNew: async (args) => {
        opened.push(args)
        return { ok: true, convId: "conv-work-1" }
      },
    },
  }
  return { ctx, dir, repoDir, taskFile, opened }
}

test("openWorkSession：foreman 开会话，提示词装配岗位文件+任务包，自动挂 watch", async () => {
  const { ctx, repoDir, taskFile, opened } = fixture()
  const r = await openWorkSession(ctx, { role: "coder", issue: "o/r#18", repo: repoDir, taskFile })
  assert.equal(r.ok, true)
  assert.equal(r.convId, "conv-work-1")
  assert.match(r.name, /^foreman-编码-o-r-18-\d{4}$/)
  assert.match(r.promptFile, /agents[\\/]coder\.md$/)
  // openNew：工作目录=worktree，noWait 后台跑
  assert.equal(opened.length, 1)
  assert.equal(opened[0].repo, repoDir)
  assert.equal(opened[0].noWait, true)
  // 首条消息两段：岗位提示词路径 + 任务包全文
  assert.match(opened[0].prompt, new RegExp(`先完整阅读你的提示词文件 .+coder\\.md`))
  assert.match(opened[0].prompt, /任务包：\n\n工单：o\/r#18\n验收：改完自测通过/)
  // watch 已挂：收工 task.update 会路由给 router
  const book = new Book(ctx.cfg.stateFile)
  const watch = Object.values(book.data.watch ?? {}).find((w) => w.target === "conv-work-1")
  assert.ok(watch, "watch 已落账本")
  assert.equal(watch.issueKey, "o/r#18")
  assert.equal(watch.repo, "o/r")
  assert.equal(watch.number, 18)
  assert.equal(ctx.state.watchers.get("conv-work-1").issueKey, "o/r#18")
})

test("openWorkSession：reviewer 角色、自定义会话名", async () => {
  const { ctx, repoDir, taskFile, opened } = fixture()
  const r = await openWorkSession(ctx, { role: "reviewer", repo: repoDir, taskFile, name: "foreman-审查-自定义" })
  assert.match(r.promptFile, /agents[\\/]reviewer\.md$/)
  assert.equal(r.name, "foreman-审查-自定义")
  assert.equal(opened[0].name, "foreman-审查-自定义")
})

test("openWorkSession：参数校验（role/repo/task-file）", async () => {
  const { ctx, repoDir, taskFile } = fixture()
  await assert.rejects(() => openWorkSession(ctx, { role: "boss", repo: repoDir, taskFile }), /role 只支持/)
  await assert.rejects(() => openWorkSession(ctx, { role: "coder", taskFile }), /repo 要是存在/)
  await assert.rejects(() => openWorkSession(ctx, { role: "coder", repo: repoDir }), /task-file 要是存在/)
  await assert.rejects(() => openWorkSession(ctx, { role: "coder", repo: repoDir, taskFile: path.join(repoDir, "不存在.md") }), /task-file 要是存在/)
  await assert.rejects(() => openWorkSession(ctx, { role: "coder", repo: repoDir, taskFile, issue: "没有单号" }), /owner\/repo#单号/)
  // 空任务包
  const empty = path.join(path.dirname(taskFile), "empty.md")
  fs.writeFileSync(empty, "  ")
  await assert.rejects(() => openWorkSession(ctx, { role: "coder", repo: repoDir, taskFile: empty }), /任务包文件是空的/)
})
