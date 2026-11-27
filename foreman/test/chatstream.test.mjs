// chatstream 测试：数据源（会话树/增量转录/载体门控）+ 真 HTTP 三路由 + SSE 分帧与并发上限。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execShell } from "../src/util.mjs"
import { createChatStreamSource } from "../src/chatstream.mjs"
import { startConsoleHttp } from "../src/consolehttp.mjs"

const SCHEMA = `
CREATE TABLE session (id text primary key, parent_id text, title text, directory text, task_type text, time_created integer, time_updated integer);
CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
`

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-cs-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = path.join(dir, "db.sqlite")
  const now = Date.now()
  const seed = `${SCHEMA}
    INSERT INTO session VALUES ('R', '', '路由', '/repo', 'interactive', ${now - 9000}, ${now - 100});
    INSERT INTO session VALUES ('C', 'R', '编码子会话', '/repo', 'subagent_child', ${now - 8000}, ${now - 2000});
    INSERT INTO message VALUES ('m1', 'R', ${now - 800}, ${now - 700}, '{"role":"user"}');
    INSERT INTO message VALUES ('m2', 'R', ${now - 700}, ${now - 600}, '{"role":"assistant","time":{"completed":${now - 600}}}');
    INSERT INTO message VALUES ('m3', 'R', ${now - 100}, ${now - 100}, '{"role":"assistant","time":{}}');
    INSERT INTO part VALUES ('p_text', 'm2', 'R', ${now - 700}, ${now - 700}, '{"type":"text","text":"路由回复"}');
    INSERT INTO part VALUES ('p_live', 'm3', 'R', ${now - 100}, ${now - 100}, '{"type":"text","text":"生成中"}');
  `
  const sqlFile = path.join(dir, "seed.sql")
  fs.writeFileSync(sqlFile, seed)
  await execShell(`sqlite3 '${db}' < '${sqlFile}'`, { timeout: 30000 })
  // 账本：一个根会话条目 + Book 的 router 记录指向它。
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ router: { convId: "R" } }))
  const entry = { key: "r", name: "路由会话", sessionId: "R", convId: "R", cwd: "/repo", status: "running", updatedAt: now }
  const dws = { ledger: { data: { sessions: { r: entry } }, resolve: (t2) => (t2 === "R" ? entry : null) } }
  const cfg = { agent: "zcode", stateFile: path.join(dir, "state.json"), zcode: { dbPath: db } }
  return { dir, db, cfg, dws, now }
}

const storeStub = { polls: () => [], operations: () => [], history: () => ({}) }

// SSE 客户端用裸 node:http（keepAlive:false）而不是 fetch：undici 的连接池在流被 cancel 后
// 不会立刻释放 socket，会挂住 node:test 的退出；裸 agent destroy() 是确定性的。
function sseGet(url) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false })
    const req = http.get(url, { agent }, (res) => resolve({ res, req, agent }))
    req.on("error", reject)
  })
}

test("数据源：会话树挂子、增量转录、未知会话只读、非 zcode 载体全空", async (t) => {
  const { cfg, dws } = await fixture(t)
  const src = createChatStreamSource({ ctx: { cfg, session: dws }, log: () => {} })

  const sess = await src.sessions()
  assert.equal(sess.carrier, "zcode")
  assert.deepEqual(sess.nodes.map((n) => [n.convId, n.depth]), [["R", 0], ["C", 1]])
  assert.equal(sess.nodes[0].status, "running") // 最后一条 assistant 未 completed
  assert.equal(sess.nodes[0].readOnly, false)
  assert.equal(sess.nodes[1].readOnly, true)
  assert.equal(sess.nodes[1].status, "done")

  const full = await src.transcript("R", 0)
  assert.equal(full.conv, "R")
  assert.equal(full.running, true)
  assert.ok(full.rows.length >= 5)
  assert.ok(full.cursor > 0)

  // 未知会话：当 zcode 会话 id 直查，只读、空转录。
  const unknown = await src.transcript("sess_nope", 0)
  assert.equal(unknown.readOnly, true)
  assert.equal(unknown.rows.length, 0)

  // 空 conv = Book router 记录解析到 R。
  const byRouter = await src.transcript("", 0)
  assert.equal(byRouter.conv, "R")

  // 非 zcode 载体：nodes/rows 全空，前端据此回退老视图。
  const srcDws = createChatStreamSource({ ctx: { cfg: { ...cfg, agent: "dws" }, dws }, log: () => {} })
  assert.deepEqual((await srcDws.sessions()).nodes, [])
  assert.deepEqual((await srcDws.transcript("R", 0)).rows, [])
})

test("HTTP：三路由可用，SSE 推快照与增量，并发超限 429", { timeout: 30000 }, async (t) => {
  const { dir, db, cfg, dws, now } = await fixture(t)
  const h = await startConsoleHttp({ store: storeStub, ctx: { cfg, session: dws }, dir: path.join(dir, "dist"), host: "127.0.0.1", port: 0, token: "", onRpc: null })
  // SSE 连接不会自然结束：teardown 用 body.cancel() 收（未读流 abort 会产生 unhandled
  // AbortError，node:test 会被它挂住），服务端的推流定时器随 req close 清掉。
  const cleanup = []
  t.after(async () => {
    for (const fn of cleanup.splice(0)) await fn()
    h.server.closeAllConnections?.()
    h.server.close()
  })

  const sessRes = await fetch(`${h.url}/api/chat/sessions`)
  const sess = await sessRes.json()
  assert.equal(sessRes.status, 200)
  assert.equal(sess.nodes.length, 2)

  const trRes = await fetch(`${h.url}/api/chat/transcript?conv=R&since=0`)
  const tr = await trRes.json()
  assert.equal(tr.rows.length >= 5, true)

  // SSE：读 snapshot，插一行新 part，等 delta 送达。
  const { res: stream, agent } = await sseGet(`${h.url}/api/chat/stream?conv=R`)
  assert.equal(stream.statusCode, 200)
  assert.match(stream.headers["content-type"] || "", /text\/event-stream/)
  cleanup.push(async () => agent.destroy())

  const events = []
  let buf = ""
  const got = (name) => events.find((e) => e.event === name)
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (frame.startsWith(":")) continue // 心跳注释
      const event = (/^event: (.+)$/m.exec(frame) || [])[1] || "message"
      const dataLine = (/^data: (.+)$/m.exec(frame) || [])[1] || ""
      events.push({ event, data: dataLine ? JSON.parse(dataLine) : null })
    }
  })
  const readEvent = async (name, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    while (!got(name) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    assert.ok(got(name), `应收到 ${name} 事件`)
    return got(name)
  }
  const snap = await readEvent("snapshot")
  assert.equal(snap.data.conv, "R")
  assert.ok(snap.data.rows.length >= 5)
  await readEvent("sessions")

  // 中途插一行新 part（增量路径），等 delta 推过来。
  const more = path.join(dir, "more.sql")
  fs.writeFileSync(more, `INSERT INTO part VALUES ('p_new', 'm3', 'R', ${now + 50}, ${now + 50}, '{"type":"text","text":"新落库的一块"}');\n`)
  await execShell(`sqlite3 '${db}' < '${more}'`, { timeout: 30000 })
  const delta = await readEvent("delta")
  assert.ok(delta.data.rows.some((r) => r.id === "p_new"))
  await cleanup.splice(0).map((fn) => fn())

  // 并发上限：占满 4 条后再开第 5 条要 429。全部走裸 http——fetch 的 body.cancel() 不会
  // 断 TCP，服务端推流循环清不掉，事件循环就退不出去。
  const agents = []
  const sseOpen = async () => {
    const { res, agent } = await sseGet(`${h.url}/api/chat/stream?conv=R`)
    agents.push(agent)
    return res
  }
  const opened = []
  for (let i = 0; i < 4; i++) opened.push(await sseOpen())
  const fifth = await sseOpen()
  assert.equal(fifth.statusCode, 429)
  cleanup.push(async () => agents.forEach((a) => a.destroy()))
})
