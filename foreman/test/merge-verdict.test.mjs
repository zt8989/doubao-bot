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
  assert.match(prompt, /可合就直接执行通知里的 `foreman pr merge` 命令/)
  assert.match(prompt, /不要输出 `<RESULT>`/)
  assert.match(prompt, /多条 PR 分别核对、分别合并/)
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
    assert.equal(rec.notify, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
