// zctranscript 单测：临时 sqlite 库（session/message/part 三表，zcode 同构）上验证
// 会话列表、父子建树、增量 tail、长文本截断、running 判定与目录回查。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execShell } from "../src/util.mjs"
import { ZcTranscript, buildWatchTree, clampText } from "../src/zctranscript.mjs"

const SCHEMA = `
CREATE TABLE session (id text primary key, parent_id text, title text, directory text, task_type text, time_created integer, time_updated integer);
CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
`

async function makeDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-zct-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = path.join(dir, "db.sqlite")
  const sqlFile = path.join(dir, "seed.sql")
  return { dir, db, sqlFile, run: async (sql) => { fs.writeFileSync(sqlFile, sql); await execShell(`sqlite3 '${db}' < '${sqlFile}'`, { timeout: 30000 }) } }
}

test("clampText：短文原样，超长留头尾并标注", () => {
  assert.equal(clampText("短的"), "短的")
  const long = "a".repeat(9000)
  const clamped = clampText(long, { head: 100, tail: 50 })
  assert.ok(clamped.startsWith("a".repeat(100)))
  assert.ok(clamped.endsWith("a".repeat(50)))
  assert.ok(clamped.includes("中间截断"))
})

test("listSessions：返回 parentId/taskType，按更新时间倒序", async (t) => {
  const { db, run } = await makeDb(t)
  const now = Date.now()
  await run(`${SCHEMA}
    INSERT INTO session VALUES ('R', '', '路由', '/repo', 'interactive', ${now - 9000}, ${now - 1000});
    INSERT INTO session VALUES ('X', '', '无关', '/other', 'interactive', ${now - 8000}, ${now - 500});
  `)
  const zc = new ZcTranscript({ dbPath: db })
  const rows = await zc.listSessions()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, "X") // 更新时间晚的在前
  assert.equal(rows[1].parentId, "")
  assert.equal(rows[1].taskType, "interactive")
})

test("buildWatchTree：子/孙挂到根、无关会话不进树", async (t) => {
  const { db, run } = await makeDb(t)
  const now = Date.now()
  await run(`${SCHEMA}
    INSERT INTO session VALUES ('R', '', '路由', '/repo', 'interactive', ${now - 9000}, ${now - 1000});
    INSERT INTO session VALUES ('C', 'R', '编码子会话', '/repo', 'subagent_child', ${now - 8000}, ${now - 2000});
    INSERT INTO session VALUES ('G', 'C', '孙会话', '/repo', 'subagent_child', ${now - 7000}, ${now - 3000});
    INSERT INTO session VALUES ('X', '', '无关桌面会话', '/other', 'interactive', ${now - 6000}, ${now - 500});
  `)
  const zc = new ZcTranscript({ dbPath: db })
  const sessions = await zc.listSessions()
  const nodes = buildWatchTree({ rootIds: new Set(["R"]), sessions, ledgerInfo: new Map([["R", { name: "路由会话", status: "running" }]]) })
  assert.deepEqual(nodes.map((n) => n.convId), ["R", "C", "G"])
  assert.deepEqual(nodes.map((n) => n.depth), [0, 1, 2])
  assert.equal(nodes[0].inLedger, true)
  assert.equal(nodes[0].name, "路由会话") // 账本名字优先于库里的 title
  assert.equal(nodes[1].inLedger, false)
  assert.equal(nodes[2].parentId, "R") // 孙会话也直接挂到根，depth 表达层级
})

test("tail：全量映射 message/part，tool 带状态与输出", async (t) => {
  const { db, run } = await makeDb(t)
  const now = Date.now()
  await run(`${SCHEMA}
    INSERT INTO session VALUES ('R', '', '路由', '/repo', 'interactive', ${now - 9000}, ${now - 100});
    INSERT INTO message VALUES ('m_user', 'R', ${now - 800}, ${now - 800}, '{"role":"user"}');
    INSERT INTO message VALUES ('m_done', 'R', ${now - 700}, ${now - 600}, '{"role":"assistant","providerId":"magpie","modelId":"glm","time":{"completed":${now - 600}}}');
    INSERT INTO message VALUES ('m_live', 'R', ${now - 100}, ${now - 100}, '{"role":"assistant","time":{}}');
    INSERT INTO part VALUES ('p_text', 'm_done', 'R', ${now - 700}, ${now - 700}, '{"type":"text","text":"你好"}');
    INSERT INTO part VALUES ('p_reason', 'm_done', 'R', ${now - 690}, ${now - 690}, '{"type":"reasoning","text":"${"思".repeat(9000)}"}');
    INSERT INTO part VALUES ('p_tool', 'm_done', 'R', ${now - 680}, ${now - 680}, '{"type":"tool","tool":"Bash","callID":"c1","state":{"status":"running","output":"半截输出"}}');
    INSERT INTO part VALUES ('p_step', 'm_live', 'R', ${now - 100}, ${now - 100}, '{"type":"step-start"}');
  `)
  const zc = new ZcTranscript({ dbPath: db })
  const { messages, parts, cursor } = await zc.tail("R")
  assert.equal(messages.length, 3)
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "assistant"])
  assert.equal(messages[1].completed, true)
  assert.equal(messages[1].model, "magpie/glm")
  assert.equal(messages[2].completed, false)
  const byId = new Map(parts.map((p) => [p.id, p]))
  assert.equal(byId.get("p_text").text, "你好")
  assert.ok(byId.get("p_reason").text.includes("中间截断"))
  assert.equal(byId.get("p_tool").tool, "Bash")
  assert.equal(byId.get("p_tool").status, "running")
  assert.ok(byId.get("p_tool").stateText.includes("半截输出"))
  assert.ok(cursor >= now - 100)
})

test("tail：增量只拿 time_updated 高于游标的新行", async (t) => {
  const { db, run } = await makeDb(t)
  const now = Date.now()
  await run(`${SCHEMA}
    INSERT INTO session VALUES ('R', '', '路由', '/repo', 'interactive', ${now - 9000}, ${now - 500});
    INSERT INTO message VALUES ('m1', 'R', ${now - 800}, ${now - 800}, '{"role":"user"}');
    INSERT INTO part VALUES ('p1', 'm1', 'R', ${now - 800}, ${now - 800}, '{"type":"text","text":"第一段"}');
  `)
  const zc = new ZcTranscript({ dbPath: db })
  const first = await zc.tail("R")
  assert.equal(first.messages.length, 1)
  assert.equal(first.parts.length, 1)
  fs.writeFileSync(path.join(path.dirname(db), "more.sql"), `INSERT INTO part VALUES ('p2', 'm1', 'R', ${now - 100}, ${now - 100}, '{"type":"text","text":"第二段"}');\n`)
  await execShell(`sqlite3 '${db}' < '${path.join(path.dirname(db), "more.sql")}'`, { timeout: 30000 })
  const inc = await zc.tail("R", { sinceMs: first.cursor })
  assert.equal(inc.parts.length, 1)
  assert.equal(inc.parts[0].id, "p2")
  assert.equal(inc.messages.length, 0)
  assert.ok(inc.cursor >= now - 100)
})

test("lastMessage/runningFlags：最后一条 assistant 未 completed = 在跑", async (t) => {
  const { db, run } = await makeDb(t)
  const now = Date.now()
  await run(`${SCHEMA}
    INSERT INTO session VALUES ('R', '', '路由', '/repo', 'interactive', ${now - 9000}, ${now - 100});
    INSERT INTO session VALUES ('S', 'R', '子', '/repo', 'subagent_child', ${now - 8000}, ${now - 200});
    INSERT INTO message VALUES ('m1', 'R', ${now - 800}, ${now - 700}, '{"role":"assistant","time":{"completed":${now - 700}}}');
    INSERT INTO message VALUES ('m2', 'R', ${now - 100}, ${now - 100}, '{"role":"assistant","time":{}}');
    INSERT INTO message VALUES ('s1', 'S', ${now - 300}, ${now - 300}, '{"role":"assistant","time":{"completed":${now - 250}}}');
  `)
  const zc = new ZcTranscript({ dbPath: db })
  // json_extract 缺键回 NULL（null），completed 判定用 Number(??"0") 兜
  assert.equal(Boolean(Number((await zc.lastMessage("R")).completed ?? 0)), false)
  assert.equal(Boolean(Number((await zc.lastMessage("S")).completed ?? 0)), true)
  const flags = await zc.runningFlags(["R", "S"])
  assert.deepEqual(flags, { R: true, S: false })
})

test("resolveSessionId：目录 + 时间窗回查最近会话", async (t) => {
  const { db, run } = await makeDb(t)
  const now = Date.now()
  await run(`${SCHEMA}
    INSERT INTO session VALUES ('old', '', '旧', '/repo', 'interactive', ${now - 3600_000}, ${now - 3000_000});
    INSERT INTO session VALUES ('new', '', '新', '/repo', 'interactive', ${now - 60_000}, ${now - 30_000});
    INSERT INTO session VALUES ('elsewhere', '', '别处', '/other', 'interactive', ${now - 1000}, ${now - 1000});
  `)
  const zc = new ZcTranscript({ dbPath: db })
  assert.equal(await zc.resolveSessionId({ directory: "/repo", sinceMs: now - 120_000 }), "new")
  assert.equal(await zc.resolveSessionId({ directory: "/nowhere", sinceMs: now }), "")
})
