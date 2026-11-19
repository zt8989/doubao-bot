// 控制台监听非回环地址时的访问控制：回环免验，外部必须带 token。
import test from "node:test"
import assert from "node:assert/strict"
import { checkConsoleToken, isLoopbackAddress } from "../src/consolehttp.mjs"
import { connectHost, resolveTarget } from "../src/svclient.mjs"

const TOKEN = "s3cret-token"

test("没有配 token：一律放行（老的纯本机行为）", () => {
  assert.deepEqual(checkConsoleToken({ token: "", remoteAddress: "192.168.1.9" }), { ok: true, setCookie: false })
})

test("回环来源不需要 token", () => {
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(addr), true)
    assert.deepEqual(checkConsoleToken({ token: TOKEN, remoteAddress: addr }), { ok: true, setCookie: false })
  }
})

test("外部来源：header / query / cookie 三种带法都认", () => {
  const base = { token: TOKEN, remoteAddress: "100.64.1.20" }
  assert.deepEqual(checkConsoleToken({ ...base, headerToken: TOKEN }), { ok: true, setCookie: false })
  assert.deepEqual(checkConsoleToken({ ...base, cookieHeader: `foreman_token=${TOKEN}; other=1` }), { ok: true, setCookie: false })
  assert.deepEqual(checkConsoleToken({ ...base, queryToken: TOKEN }), { ok: true, setCookie: true })
})

test("外部来源：没带或带错都拒绝", () => {
  const base = { token: TOKEN, remoteAddress: "100.64.1.20" }
  assert.equal(checkConsoleToken(base).ok, false)
  assert.equal(checkConsoleToken({ ...base, headerToken: "wrong" }).ok, false)
  assert.equal(checkConsoleToken({ ...base, queryToken: "" }).ok, false)
})

test("客户端连接地址：监听全零就走回环，否则用配置里的 host", () => {
  assert.equal(connectHost("0.0.0.0"), "127.0.0.1")
  assert.equal(connectHost("::"), "127.0.0.1")
  assert.equal(connectHost(""), "127.0.0.1")
  assert.equal(connectHost("192.168.1.5"), "192.168.1.5")
  assert.deepEqual(resolveTarget({ service: { http: { host: "0.0.0.0", port: 7317 } } }), { host: "127.0.0.1", port: 7317 })
})
