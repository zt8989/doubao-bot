import test from "node:test"
import assert from "node:assert/strict"
import { parseResult, issueBranch, kickoff } from "../src/prompts.mjs"

test("取最后一个 RESULT 块（前面可能贴过历史块）", () => {
  const text = [
    "<RESULT>{\"status\":\"failed\",\"summary\":\"第一次没成\"}</RESULT>",
    "中间又改了一轮……",
    '<RESULT>{"status":"done","branch":"fix/issue-255","tests":"mvn -q test 通过","summary":"补了 sandbox 配置"}</RESULT>',
  ].join("\n")
  const r = parseResult(text)
  assert.equal(r.status, "done")
  assert.equal(r.branch, "fix/issue-255")
  assert.equal(r.tests, "mvn -q test 通过")
})

test("RESULT 里包了 ```json 也认", () => {
  const r = parseResult('<RESULT>```json\n{"status":"need_decision","question":"基线用哪个分支？"}\n```</RESULT>')
  assert.equal(r.status, "need_decision")
  assert.equal(r.question, "基线用哪个分支？")
})

test("没有 RESULT 标签、但结尾直接甩了 JSON 也认", () => {
  const r = parseResult('改完了。\n{"status":"done","summary":"改了两处"}')
  assert.equal(r.status, "done")
  assert.equal(r.summary, "改了两处")
})

test("什么都没交 → none，别当成 failed 去重试", () => {
  const r = parseResult("我还在看代码。")
  assert.equal(r.status, "none")
})

test("状态别名归一化", () => {
  assert.equal(parseResult('{"status":"ok"}').status, "done")
  assert.equal(parseResult('{"status":"ERROR"}').status, "failed")
  assert.equal(parseResult('{"status":"ask","question":"要不要删旧接口"}').status, "need_decision")
})

test("RESULT 里的 pr / prUrl 会带出来（按键名透传）", () => {
  const r = parseResult('<RESULT>{"status":"done","branch":"fix/issue-1","pr":12,"prUrl":"http://g/pulls/12","tests":"ok","summary":"x"}</RESULT>')
  assert.equal(r.status, "done")
  assert.equal(r.pr, 12)
  assert.equal(r.prUrl, "http://g/pulls/12")
  const r2 = parseResult('<RESULT>{"status":"done","summary":"没填 PR"}</RESULT>')
  assert.equal(r2.pr, null)
  assert.equal(r2.prUrl, "")
})

test("分支名：中文标题不加拼音 slug，英文标题加", () => {
  assert.equal(issueBranch({ number: 255 }, "本地 Linux 沙盒模式实现"), "fix/issue-255")
  assert.equal(issueBranch({ number: 12 }, "add retry to cdp client"), "fix/issue-12-add-retry-to-cdp-client")
})

test("kickoff 里写死了边界（自测过了自己 push 开 PR、只在该 worktree 改）", () => {
  const p = kickoff({
    repo: "yyzl/win-ai-harness",
    issue: { number: 255, title: "沙盒模式", body: "正文" },
    worktree: "/tmp/wt/fix-issue-255",
    branch: "fix/issue-255",
    base: "dev",
  })
  assert.match(p, /只在这个工作区里改：\/tmp\/wt\/fix-issue-255/)
  assert.match(p, /自测通过后[^\n]*git push -u origin/)
  assert.match(p, /foreman pr open --repo yyzl\/win-ai-harness --base dev --head fix\/issue-255/)
  assert.match(p, /不要直接 opencli gitea pr/)
  assert.match(p, /填进 RESULT 的 pr \/ prUrl/)
  assert.match(p, /合并由 foreman 做/)
  assert.match(p, /opencli gitea issue-comment\|close\|issue-edit/)
  assert.match(p, /<RESULT>/)
})
