// 控制台「项目」面板：/api/products GET 读当前产品/工程；POST 保存 =
// 同 loadConfig 一套校验 → 原子写回 config.json → 热替换内存 cfg（实时生效）。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../src/config.mjs"
import { startServer } from "../src/service.mjs"

function startServerCfg(obj = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-products-srv-"))
  const file = path.join(dir, "foreman.json")
  fs.writeFileSync(file, JSON.stringify({
    stateFile: path.join(dir, "state.json"),
    agent: "noop",
    products: [
      {
        name: "demo",
        projectDir: dir,
        repos: [
          { name: "repo-a", repo: "acme/repo-a", dir: path.join(dir, "repo-a"), base: "sit-1", verify: [] },
          { name: "repo-b", repo: "acme/repo-b", dir: path.join(dir, "repo-b"), base: "sit-1", verify: [] },
        ],
      },
    ],
    service: {
      http: { port: 0, portFile: path.join(dir, "service.port"), db: path.join(dir, "console.db") },
      pidFile: path.join(dir, "foreman.pid"),
      logFile: path.join(dir, "service.log"),
      handshakeTimeoutMs: 500,
      stopTimeoutMs: 500,
    },
    ...obj,
  }))
  return { cfg: loadConfig(file), dir, file }
}

test("/api/products：GET 读当前产品；POST 改 base 写盘 + 热替换 cfg.repos（实时生效）", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg, dir } = startServerCfg()
  const server = await startServer({ cfg, book: null, dws: { runningMap: async () => ({}) }, log: () => {} })
  try {
    const get1 = await (await fetch(`http://127.0.0.1:${server.port}/api/products`)).json()
    assert.equal(get1.ok, true)
    assert.equal(get1.products.length, 1)
    assert.equal(get1.products[0].repos.length, 2)
    assert.equal(get1.products[0].repos[0].base, "sit-1")

    // 只改 repo-a 的基线：响应、磁盘 config.json、内存 cfg.repos 三处都要是新值
    const products = JSON.parse(JSON.stringify(get1.products))
    products[0].repos[0].base = "sit-2"
    const post = await fetch(`http://127.0.0.1:${server.port}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products }),
    })
    const saved = await post.json()
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.warnings, [])
    const onDisk = JSON.parse(fs.readFileSync(cfg.configFile, "utf8"))
    assert.equal(onDisk.products[0].repos[0].base, "sit-2")
    assert.equal(onDisk.products[0].repos[1].base, "sit-1")
    const live = server.ctx.cfg.repos.find((r) => r.repo === "acme/repo-a")
    assert.equal(live.base, "sit-2", "内存 cfg.repos 要原地热替换，下一轮轮询即读到新基线")
    // 共享引用不变式：cfg.repos 与 products[].repos 同一批对象（loadConfig 口径）
    assert.equal(server.ctx.cfg.products[0].repos[0], live)

    // 再 GET 一遍：读到保存后的值
    const get2 = await (await fetch(`http://127.0.0.1:${server.port}/api/products`)).json()
    assert.equal(get2.products[0].repos[0].base, "sit-2")
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("/api/products：缺 base、清空 products 都 400", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg, dir } = startServerCfg()
  const server = await startServer({ cfg, book: null, dws: { runningMap: async () => ({}) }, log: () => {} })
  try {
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products: [{ name: "demo", repos: [{ repo: "acme/repo-a", dir: "/tmp/x" }] }] }),
    })
    assert.equal(bad.status, 400)
    const badBody = await bad.json()
    assert.equal(badBody.error, "products_invalid")

    const empty = await fetch(`http://127.0.0.1:${server.port}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products: [] }),
    })
    assert.equal(empty.status, 400)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("/api/products：在途工单——改 base 出 warnings；删工程 409 需 force", async () => {
  delete process.env.FOREMAN_SERVE
  const { cfg, dir } = startServerCfg()
  const server = await startServer({ cfg, book: null, dws: { runningMap: async () => ({}) }, log: () => {} })
  try {
    // 种一条在途工单（state=working 记着 repo-b）
    fs.writeFileSync(cfg.stateFile, JSON.stringify({
      issues: { "acme/repo-b#7": { repo: "acme/repo-b", number: 7, state: "working", branch: "issue-7" } },
    }))

    // 改 repo-b 基线：不阻塞，但要有 warnings 指名在途工单仍按旧基线走
    const view = server.ctx.productsView()
    const products = JSON.parse(JSON.stringify(view.products))
    products[0].repos[1].base = "sit-2"
    const saved = server.ctx.applyProducts({ products })
    assert.equal(saved.ok, true)
    assert.equal(saved.warnings.length, 1)
    assert.match(saved.warnings[0], /acme\/repo-b/)
    assert.match(saved.warnings[0], /sit-1 → sit-2/)
    assert.match(saved.warnings[0], /#7/)

    // 删掉 repo-b：有在途工单 → 409 repo_busy
    const del = await fetch(`http://127.0.0.1:${server.port}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products: [products[0]].map((p) => ({ ...p, repos: p.repos.filter((r) => r.repo !== "acme/repo-b") })) }),
    })
    assert.equal(del.status, 409)
    const delBody = await del.json()
    assert.equal(delBody.error, "repo_busy")
    assert.deepEqual(delBody.repos, ["acme/repo-b"])
    assert.deepEqual(delBody.inflight[0].issues, ["acme/repo-b#7"])

    // 强制保存：删掉 repo-b，磁盘与内存同步
    const forced = await fetch(`http://127.0.0.1:${server.port}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products: [products[0]].map((p) => ({ ...p, repos: p.repos.filter((r) => r.repo !== "acme/repo-b") })), force: true }),
    })
    const forcedBody = await forced.json()
    assert.equal(forcedBody.ok, true)
    const onDisk = JSON.parse(fs.readFileSync(cfg.configFile, "utf8"))
    assert.equal(onDisk.products[0].repos.length, 1)
    assert.equal(server.ctx.cfg.repos.length, 1)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
