// 合并助手：核对后直接执行 foreman pr merge，不交 RESULT。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { deliverNewSession } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-merge-"))
}

test("内置合并提示词要求直接合并，不使用 RESULT 协议", () => {
  const prompt = fs.readFileSync(new URL("../src/builtin/merge-prompt.md", import.meta.url), "utf8")
  assert.match(prompt, /按通知给出的命令逐条合并/)
  assert.match(prompt, /按回包内容直接汇报/)
  assert.match(prompt, /已合过（head 已是 base 祖先）/)
  assert.match(prompt, /UI 人工验收闸门/)
  assert.match(prompt, /用户已完成人工验收并回复「合并」/)
  assert.doesNotMatch(prompt, /只判可合性|foreman 会自动合并|人工兜底/)
})

test("deliverNewSession：合并会话记下触发类型与仓库", async () => {
  const dir = tmpDir()
  try {
    const cfg = {
      stateFile: path.join(dir, "state.json"),
      deliver: { mode: "new", promptFile: path.join(dir, "merge.md"), waitFirstReply: false },
    }
    fs.writeFileSync(path.join(dir, "merge.md"), "# 合并助手\n")
    const book = new Book(cfg.stateFile)
    book.data.router = { convId: "conv-router" }
    book.record("foreman-router", { convId: "conv-router", kind: "router", role: "router" })
    const ctx = {
      cfg,
      log: () => {},
      dws: { openNew: async () => ({ convId: "conv-new" }) },
    }
    const out = await deliverNewSession(ctx, { text: "PR demo/demo#268 待合并", kind: "PR待合并", repo: "demo/demo", lane: "merge" })
    assert.equal(out.convId, "conv-new")
    const rec = new Book(cfg.stateFile).session(out.session)
    assert.equal(rec.notice, "PR待合并")
    assert.equal(rec.repo, "demo/demo")
    assert.equal(rec.kind, "deliver:merge")
    assert.equal(rec.parent, "conv-router", "合并智能体挂在分配它的路由智能体下")
    assert.equal(rec.notify, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
