// 通知会话收尾：一条「PR待合并」投递会话报过的 PR 全部合完后，服务要自动把它归档，
// 不能像 #235/#238 那样把会话一直留在侧边栏。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Book } from "../src/book.mjs"
import { archiveMergedNotices } from "../src/service.mjs"

const tmpBook = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-notice-"))
  return path.join(dir, "state.json")
}

const archived = () => {
  const calls = []
  return { calls, dws: { archive: async (name) => { calls.push(name) } } }
}

test("PR 全合完：通知会话自动归档，账本里的 notice 记录摘掉", async () => {
  const file = tmpBook()
  const b = new Book(file)
  b.markPrSeen("yyzl/yyjz-oa-frontend#235", { repo: "yyzl/yyjz-oa-frontend", number: 235, skipped: "merged", merged: true })
  b.markNotice("foreman-PR待合并-20261112-1402", {
    name: "foreman-PR待合并-20261112-1402", convId: "38452532177117186", kind: "PR待合并",
    prs: ["yyzl/yyjz-oa-frontend#235"],
  })

  const { calls, dws } = archived()
  const notes = await archiveMergedNotices({ session: dws, stateFile: file })

  assert.deepEqual(calls, ["foreman-PR待合并-20261112-1402"])
  assert.equal(notes.length, 1)
  assert.equal(new Book(file).notices["foreman-PR待合并-20261112-1402"], undefined)
})

test("还有没合的 PR：不归档", async () => {
  const file = tmpBook()
  const b = new Book(file)
  b.markPrSeen("yyzl/yyjz-oa-frontend#235", { repo: "yyzl/yyjz-oa-frontend", number: 235, skipped: "merged", merged: true })
  b.markPrSeen("yyzl/yyjz-oa-frontend#238", { repo: "yyzl/yyjz-oa-frontend", number: 238 })
  b.markNotice("foreman-PR待合并-20261112-1440", {
    name: "foreman-PR待合并-20261112-1440", convId: "38453350711358210", kind: "PR待合并",
    prs: ["yyzl/yyjz-oa-frontend#235", "yyzl/yyjz-oa-frontend#238"],
  })

  const { calls, dws } = archived()
  const notes = await archiveMergedNotices({ session: dws, stateFile: file })

  assert.deepEqual(calls, [])
  assert.equal(notes.length, 0)
  assert.ok(new Book(file).notices["foreman-PR待合并-20261112-1440"])
})

test("归档失败：预留记录下轮重试，不抛错", async () => {
  const file = tmpBook()
  const b = new Book(file)
  b.markPrSeen("yyzl/win-ai-harness#270", { repo: "yyzl/win-ai-harness", number: 270, skipped: "merged", merged: true })
  b.markNotice("foreman-PR待合并-20261112-1116", { name: "foreman-PR待合并-20261112-1116", prs: ["yyzl/win-ai-harness#270"] })

  const dws = { archive: async () => { throw new Error("app_busy") } }
  const notes = await archiveMergedNotices({ session: dws, stateFile: file })

  assert.equal(notes.length, 1)
  assert.match(notes[0], /归档失败/)
  assert.ok(new Book(file).notices["foreman-PR待合并-20261112-1116"], "失败要留下记录，下一轮再试")
})

test("会话已不在侧边栏：收掉记录，不再每轮刷失败日志", async () => {
  const file = tmpBook()
  const b = new Book(file)
  b.markPrSeen("yyzl/yyjz-oa-frontend#235", { repo: "yyzl/yyjz-oa-frontend", number: 235, skipped: "merged", merged: true })
  b.markNotice("foreman-合并-20261113-1400", {
    name: "foreman-合并-20261113-1400", convId: "38453350711358211", kind: "合并",
    prs: ["yyzl/yyjz-oa-frontend#235"],
  })

  const dws = { archive: async (name) => { throw new Error("侧边栏里没有任务 " + name) } }
  const logs = []
  const notes = await archiveMergedNotices({ session: dws, stateFile: file, log: (m) => logs.push(m) })

  assert.equal(notes.length, 1)
  assert.match(notes[0], /已不在侧边栏/)
  assert.doesNotMatch(notes[0], /归档失败/)
  assert.equal(new Book(file).notices["foreman-合并-20261113-1400"], undefined, "记录收掉，不再重试")
  assert.match(logs.join("\n"), /不再重试/)
  // 第二轮：没有任何要处理的
  const again = await archiveMergedNotices({ session: dws, stateFile: file, log: () => {} })
  assert.equal(again.length, 0)
})
