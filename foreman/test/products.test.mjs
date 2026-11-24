// 产品分组：一个产品一套仓库 + 自己的提示词 + 自己的监控项目根目录。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../src/config.mjs"
import { productOf, deliverContextFor, deliverNewSession } from "../src/service.mjs"
import { Book } from "../src/book.mjs"

function tmpConfig(user, { promptA = "产品A提示词", promptB = "产品B提示词", global = "全局提示词" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-products-"))
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true })
  fs.writeFileSync(path.join(dir, "prompts", "a.md"), promptA)
  fs.writeFileSync(path.join(dir, "prompts", "b.md"), promptB)
  fs.writeFileSync(path.join(dir, "prompts", "global.md"), global)
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, JSON.stringify(user))
  return { dir, file }
}

test("products：每个产品一套仓库，摊平进 cfg.repos，并带上产品名", () => {
  const { file } = tmpConfig({
    deliver: { mode: "new", promptFile: "prompts/global.md", projectDir: "~/work/global" },
    products: [
      {
        name: "win-ai-stack",
        promptFile: "prompts/a.md",
        projectDir: "~/Documents/workspace/win-ai-stack",
        repos: [{ repo: "yyzl/win-ai-harness", dir: "~/work/a", base: "sit-20261126" }],
      },
      {
        name: "yyjz-oa",
        projectDir: "~/Documents/workspace/oa",
        repos: [{ repo: "yyzl/yyjz-oa-cloud", dir: "~/work/b", base: "sit-20261126" }],
      },
    ],
  })
  const cfg = loadConfig(file)
  assert.equal(cfg.products.length, 2)
  assert.deepEqual(cfg.repos.map((r) => r.repo), ["yyzl/win-ai-harness", "yyzl/yyjz-oa-cloud"])
  assert.deepEqual(cfg.repos.map((r) => r.product), ["win-ai-stack", "yyjz-oa"])
  // 相对路径落到配置文件同目录；产品 B 没给提示词 → 回落顶层 deliver。
  assert.ok(cfg.products[0].promptFile.endsWith(path.join("prompts", "a.md")))
  assert.equal(cfg.products[1].promptFile, "")
})

test("products 缺名字、没有 repos、提示词文件不存在都直接报错", () => {
  assert.throws(() => loadConfig(tmpConfig({ products: [{ repos: [{ repo: "a/b", dir: "/tmp", base: "sit" }] }] }).file), /name 必填/)
  assert.throws(() => loadConfig(tmpConfig({ products: [{ name: "p", repos: [] }] }).file), /至少要给一条 repos/)
  assert.throws(() => loadConfig(tmpConfig({
    deliver: { mode: "new" },
    products: [{ name: "p", promptFile: "prompts/nope.md", repos: [{ repo: "a/b", dir: "/tmp", base: "sit" }] }],
  }).file), /promptFile/)
})

test("deliverContextFor：产品配了就用产品的，没配回落全局", () => {
  const { file } = tmpConfig({
    deliver: { mode: "new", promptFile: "prompts/global.md", projectDir: "~/work/global" },
    products: [
      { name: "win-ai-stack", promptFile: "prompts/a.md", projectDir: "~/work/stack", repos: [{ repo: "yyzl/win-ai-harness", dir: "/tmp/a", base: "sit" }] },
      { name: "yyjz-oa", repos: [{ repo: "yyzl/yyjz-oa-cloud", dir: "/tmp/b", base: "sit" }] },
    ],
  })
  const cfg = loadConfig(file)
  const a = deliverContextFor(cfg, "yyzl/win-ai-harness")
  assert.equal(a.product, "win-ai-stack")
  assert.ok(a.promptFile.endsWith(path.join("prompts", "a.md")))
  assert.equal(a.projectDir, path.join(os.homedir(), "work/stack"))

  // 产品 B 没给提示词/目录 → 全局。
  const b = deliverContextFor(cfg, "yyjz-oa-cloud")
  assert.equal(b.product, "yyjz-oa")
  assert.ok(b.promptFile.endsWith(path.join("prompts", "global.md")))

  // 短名也能对上；不认识的仓库回落全局、产品名为空。
  assert.equal(productOf(cfg, "win-ai-harness").name, "win-ai-stack")
  assert.equal(deliverContextFor(cfg, "someone/else").product, "")
})

test("deliverNewSession：用产品自己的提示词与项目目录，首句带产品名", async () => {
  const { file, dir } = tmpConfig({
    deliver: { mode: "new", promptFile: "prompts/global.md", projectDir: "~/work/global" },
    products: [
      { name: "win-ai-stack", promptFile: "prompts/a.md", projectDir: "~/work/stack", repos: [{ repo: "yyzl/win-ai-harness", dir: "/tmp/a", base: "sit" }] },
    ],
  })
  const cfg = loadConfig(file)
  const calls = []
  const ctx = {
    cfg,
    dws: { openNew: async (args) => { calls.push(args); return { convId: "1" } } },
    log: () => {},
  }
  await deliverNewSession(ctx, { text: "状态：done", kind: "工单结论", watcher: { repo: "yyzl/win-ai-harness" } })
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /产品A提示词/)
  assert.match(calls[0].prompt, /产品：win-ai-stack/)
  // Windows 上项目目录是 `C:\...` 原生路径，POSIX 是 `/...`，两种都算对
  assert.match(calls[0].prompt, /监控项目：(?:\w:)?[\\/].*work[\\/]stack/)
  assert.ok(!calls[0].prompt.includes("全局提示词"))

  const book = new Book(path.join(path.dirname(file), "state.json"))
  const rec = book.sessions[calls[0].name]
  assert.equal(rec.notify, false)
  assert.equal(rec.product, "win-ai-stack")
  assert.ok(dir)
})

test("deliverNewSession：查不到产品时用全局提示词（老配置行为不变）", async () => {
  const { file } = tmpConfig({
    deliver: { mode: "new", promptFile: "prompts/global.md", projectDir: "~/work/global" },
    products: [
      { name: "win-ai-stack", promptFile: "prompts/a.md", projectDir: "~/work/stack", repos: [{ repo: "yyzl/win-ai-harness", dir: "/tmp/a", base: "sit" }] },
    ],
  })
  const cfg = loadConfig(file)
  const calls = []
  await deliverNewSession({ cfg, dws: { openNew: async (a) => { calls.push(a); return { convId: "1" } } }, log: () => {} }, {
    text: "PR 待合并", kind: "PR待合并", repo: "someone/else",
  })
  assert.match(calls[0].prompt, /全局提示词/)
  assert.ok(!calls[0].prompt.includes("产品："))
})

test("worktreeHook 配置穿透：products[].repos 归一化成字符串数组，未配的仓拿到空数组", () => {
  // 配了 products 时顶层 repos 会被摊平结果覆盖（既有行为），统一用两条 product 仓断言。
  const { file } = tmpConfig({
    products: [
      { name: "p", repos: [{ repo: "a/top", dir: "/tmp/top", base: "main", worktreeHook: ["pnpm install", "  ", 42, "pnpm build"] }] },
      { name: "q", repos: [{ repo: "b/prod", dir: "/tmp/prod", base: "main", worktreeHook: ["pnpm install --frozen-lockfile"] }] },
    ],
  })
  const cfg = loadConfig(file)
  assert.deepEqual(cfg.repos.find((r) => r.repo === "a/top").worktreeHook, ["pnpm install", "pnpm build"], "非字符串与空白项被过滤")
  assert.deepEqual(cfg.repos.find((r) => r.repo === "b/prod").worktreeHook, ["pnpm install --frozen-lockfile"])
  const { file: f2 } = tmpConfig({ repos: [{ repo: "a/b", dir: "/tmp", base: "main" }] })
  assert.deepEqual(loadConfig(f2).repos[0].worktreeHook, [], "没配的仓拿到空数组（不 undefined，调用方免判）")
})
