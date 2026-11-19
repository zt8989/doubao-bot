// REST 层单测：不出网，用假的 fetch 验证参数拼装、结构与错误口径。
import { test } from "node:test"
import assert from "node:assert/strict"
import * as api from "../src/api.mjs"
import { GiteaApiError, request } from "../src/client.mjs"

const BASE = "http://gitea.test"
const SETTINGS = { baseUrl: BASE, token: "t0ken", tokenSource: "test" }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const u = new URL(String(url))
    calls.push({ method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body })
    return handler({ method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body }, calls.length)
  }
  impl.calls = calls
  return impl
}

const issue = (over = {}) => ({
  number: 7,
  title: "t",
  state: "open",
  body: "b",
  labels: [{ id: 5, name: "ready-for-agent" }],
  assignees: [],
  user: { login: "alice" },
  comments: 0,
  html_url: `${BASE}/o/r/issues/7`,
  ...over,
})

test("listIssues：数字标签先翻成名字再按 id 过滤", async () => {
  const fetchImpl = fakeFetch(({ path }) => {
    if (path === "/api/v1/repos/o/r/labels") return json([{ id: 5, name: "ready-for-agent" }])
    if (path === "/api/v1/orgs/o/labels") return json([{ id: 3, name: "needs-triage" }])
    if (path === "/api/v1/repos/o/r/issues") {
      return json([issue(), issue({ number: 8, labels: [{ id: 3, name: "needs-triage" }] })])
    }
    return json({ message: "unexpected" }, 500)
  })
  const list = await api.listIssues("o/r", { labels: "5", opts: { settings: SETTINGS, fetchImpl } })
  assert.deepEqual(list.map((i) => i.number), [7])
  const issueCall = fetchImpl.calls.find((c) => c.path === "/api/v1/repos/o/r/issues")
  assert.equal(issueCall.query.labels, "ready-for-agent")
  assert.equal(list[0].body, undefined, "列表不回正文")
})

test("listIssues：标签 id 不存在时报 not_found，而不是静默全量", async () => {
  const fetchImpl = fakeFetch(({ path }) => {
    if (path === "/api/v1/repos/o/r/labels") return json([{ id: 18, name: "enhancement" }])
    if (path === "/api/v1/orgs/o/labels") return json([], 404)
    return json([])
  })
  await assert.rejects(
    api.listIssues("o/r", { labels: "5", opts: { settings: SETTINGS, fetchImpl } }),
    (e) => e instanceof GiteaApiError && e.code === "not_found" && /标签 id 5/.test(e.message),
  )
})

test("listLabels：仓库标签并入组织标签", async () => {
  const fetchImpl = fakeFetch(({ path }) => {
    if (path === "/api/v1/repos/o/r/labels") return json([{ id: 18, name: "enhancement" }])
    if (path === "/api/v1/orgs/o/labels") return json([{ id: 3, name: "needs-triage" }, { id: 18, name: "enhancement" }])
    return json([])
  })
  const labels = await api.listLabels({ repo: "o/r", opts: { settings: SETTINGS, fetchImpl } })
  assert.deepEqual(
    labels.map((l) => [l.id, l.name, l.scope]),
    [[18, "enhancement", "repo"], [3, "needs-triage", "org"]],
  )
})

test("listLabels：组织标签接口 404 时只回仓库标签", async () => {
  const fetchImpl = fakeFetch(({ path }) => {
    if (path === "/api/v1/repos/o/r/labels") return json([{ id: 18, name: "enhancement" }])
    if (path === "/api/v1/orgs/o/labels") return json({ message: "not found" }, 404)
    return json([])
  })
  const labels = await api.listLabels({ repo: "o/r", opts: { settings: SETTINGS, fetchImpl } })
  assert.deepEqual(labels.map((l) => l.name), ["enhancement"])
})

test("editIssue：ref 更新工单右侧分支字段并保留返回值", async () => {
  const fetchImpl = fakeFetch(({ method, path }) => {
    if (method === "PATCH" && path === "/api/v1/repos/o/r/issues/7") return json(issue({ ref: "fix/issue-7" }))
    return json({ message: "unexpected" }, 500)
  })
  const out = await api.editIssue("o/r", 7, { ref: "fix/issue-7" }, { opts: { settings: SETTINGS, fetchImpl } })
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { ref: "fix/issue-7" })
  assert.equal(out.ref, "fix/issue-7")
})

test("createIssueBranch：建分支后回写工单右侧 ref", async () => {
  let created = false
  const fetchImpl = fakeFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/v1/repos/o/r/issues/7") return json(issue({ title: "Fix login" }))
    if (method === "GET" && path === "/api/v1/repos/o/r") return json({ default_branch: "main" })
    if (method === "GET" && path === "/api/v1/repos/o/r/branches/issue-7-fix-login") {
      return created ? json({ name: "issue-7-fix-login" }) : json({ message: "not found" }, 404)
    }
    if (method === "POST" && path === "/api/v1/repos/o/r/branches") {
      created = true
      return json({ name: "issue-7-fix-login" }, 201)
    }
    if (method === "PATCH" && path === "/api/v1/repos/o/r/issues/7") {
      return json(issue({ ref: "issue-7-fix-login" }))
    }
    return json({ message: "unexpected" }, 500)
  })
  const out = await api.createIssueBranch("o/r", 7, {
    name: "fix-login",
    base: "sit-20261126",
    opts: { settings: SETTINGS, fetchImpl },
  })
  const createIndex = fetchImpl.calls.findIndex((c) => c.method === "POST" && c.path === "/api/v1/repos/o/r/branches")
  const patchIndex = fetchImpl.calls.findIndex((c) => c.method === "PATCH" && c.path === "/api/v1/repos/o/r/issues/7")
  assert.ok(createIndex >= 0 && patchIndex > createIndex, "必须先建分支，再更新工单 ref")
  assert.deepEqual(JSON.parse(fetchImpl.calls[patchIndex].body), { ref: "issue-7-fix-login" })
  assert.equal(out.branch, "issue-7-fix-login")
})

test("editIssueLabels：--label-add needs-triage 用组织标签 id 发 POST", async () => {
  let wrote = false
  const fetchImpl = fakeFetch(({ method, path }) => {
    if (path === "/api/v1/repos/o/r/labels") return json([{ id: 18, name: "enhancement" }])
    if (path === "/api/v1/orgs/o/labels") return json([{ id: 3, name: "needs-triage" }])
    if (path === "/api/v1/repos/o/r/issues/7/labels" && method === "POST") {
      wrote = true
      return json([])
    }
    if (path === "/api/v1/repos/o/r/issues/7") {
      return json(
        issue({
          labels: wrote
            ? [{ id: 18, name: "enhancement" }, { id: 3, name: "needs-triage" }]
            : [{ id: 18, name: "enhancement" }],
        }),
      )
    }
    return json({ message: "unexpected" }, 500)
  })
  const out = await api.editIssueLabels("o/r", 7, { add: ["needs-triage"], opts: { settings: SETTINGS, fetchImpl } })
  const post = fetchImpl.calls.find((c) => c.method === "POST" && c.path.endsWith("/labels"))
  assert.deepEqual(JSON.parse(post.body), { labels: [3] })
  assert.equal(out.changed, true)
  assert.deepEqual(out.labels.map((l) => l.name), ["enhancement", "needs-triage"])
})

test("mergePull：已合并直接 empty_result，不再发 merge", async () => {
  const fetchImpl = fakeFetch(({ path }) => {
    if (path === "/api/v1/repos/o/r/pulls/9") return json({ number: 9, state: "closed", merged: true })
    return json({ message: "should not merge" }, 500)
  })
  await assert.rejects(
    api.mergePull("o/r", 9, { opts: { settings: SETTINGS, fetchImpl } }),
    (e) => e instanceof GiteaApiError && e.code === "empty_result" && /无需重复合并/.test(e.message),
  )
  assert.equal(fetchImpl.calls.filter((c) => c.method === "POST").length, 0)
})

test("setIssueState：已是目标状态时报 empty_result", async () => {
  const fetchImpl = fakeFetch(() => json(issue({ state: "closed" })))
  await assert.rejects(
    api.setIssueState("o/r", 7, "closed", { opts: { settings: SETTINGS, fetchImpl } }),
    (e) => e.code === "empty_result" && /无需重复关闭/.test(e.message),
  )
})

test("request：401 归一为 auth_required 且不泄露令牌", async () => {
  const fetchImpl = fakeFetch(() => json({ message: "token is expired" }, 401))
  await assert.rejects(
    request("/api/v1/version", { settings: SETTINGS, fetchImpl }),
    (e) =>
      e instanceof GiteaApiError &&
      e.code === "auth_required" &&
      e.status === 401 &&
      !e.message.includes("t0ken"),
  )
})

test("createIssue：标签名字翻成 id，里程碑用数字 id", async () => {
  const fetchImpl = fakeFetch(({ method, path, body }) => {
    if (path === "/api/v1/repos/o/r/milestones") return json([{ id: 4, title: "1126" }])
    if (path === "/api/v1/repos/o/r/labels") return json([{ id: 18, name: "enhancement" }])
    if (path === "/api/v1/orgs/o/labels") return json([{ id: 3, name: "needs-triage" }])
    if (path === "/api/v1/repos/o/r/issues" && method === "POST") {
      const payload = JSON.parse(body)
      assert.deepEqual(payload, { title: "T", body: "B", labels: [3], milestone: 4 })
      return json(issue({ number: 11, title: "T" }))
    }
    return json({}, 500)
  })
  const created = await api.createIssue("o/r", {
    title: "T",
    body: "B",
    labels: ["needs-triage"],
    milestone: 4,
    opts: { settings: SETTINGS, fetchImpl },
  })
  assert.equal(created.number, 11)
})

test("createPull：draft 用 WIP 前缀模拟，返回 number/url", async () => {
  const fetchImpl = fakeFetch(({ method, path, body }) => {
    if (path === "/api/v1/repos/o/r/pulls" && method === "POST") {
      assert.equal(JSON.parse(body).title, "WIP: 草稿")
      return json({ number: 12, html_url: `${BASE}/o/r/pulls/12` })
    }
    return json({}, 500)
  })
  const pr = await api.createPull("o/r", { base: "main", head: "b", title: "草稿", draft: true, opts: { settings: SETTINGS, fetchImpl } })
  assert.equal(pr.number, 12)
  assert.equal(pr.url, `${BASE}/o/r/pulls/12`)
})

test("pr-view：state/head/comments 映射正常", async () => {
  const fetchImpl = fakeFetch(({ path }) => {
    if (path === "/api/v1/repos/o/r/pulls/9") {
      return json({
        number: 9,
        title: "P",
        state: "closed",
        merged: false,
        mergeable: true,
        merge_base: "sha1",
        head: { label: "feat/x", ref: "refs/pull/9/head", sha: "sha1" },
        base: { label: "main", ref: "main", sha: "base" },
        changed_files: 2,
        user: { login: "bob" },
        html_url: `${BASE}/o/r/pulls/9`,
      })
    }
    if (path === "/api/v1/repos/o/r/issues/9/comments") return json([])
    if (path === "/api/v1/repos/o/r/pulls/9/commits") return json([])
    return json({}, 500)
  })
  const pr = await api.viewPull("o/r", 9, { opts: { settings: SETTINGS, fetchImpl } })
  assert.equal(pr.state, "closed")
  assert.equal(pr.head, "feat/x")
  assert.equal(pr.base, "main")
  assert.equal(pr.mergeNote, "合并请求已关闭，无法合并")
  assert.equal(pr.filesCount, 2)
  assert.deepEqual(pr.comments, [])
})
