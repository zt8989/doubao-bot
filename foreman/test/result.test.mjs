import test from "node:test"
import assert from "node:assert/strict"
import { parseResult, issueBranch, kickoff, resume } from "../src/prompts.mjs"

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

test("kickoff 写死编码智能体职责：非保护分支 push、开 PR、按审查意见修复", () => {
  const p = kickoff({
    repo: "yyzl/win-ai-harness",
    issue: { number: 255, title: "沙盒模式", body: "正文" },
    worktree: "/tmp/wt/fix-issue-255",
    branch: "fix/issue-255",
    base: "dev",
  })
  assert.match(p, /一工程一工作区/)
  assert.match(p, /工作区：\/tmp\/wt\/fix-issue-255/)
  assert.match(p, /工单键：yyzl\/win-ai-harness#255/)
  assert.match(p, /改完就 commit/)
  assert.match(p, /只允许推送到派单指定的非保护工作分支/)
  assert.match(p, /foreman pr open/)
  assert.match(p, /填写 PR 模板、关联工单并附测试结果/)
  assert.match(p, /不合并 PR/)
  assert.match(p, /按对抗审查意见修复/)
  assert.match(p, /缺工作区：<owner\/name>/)
  assert.match(p, /gitea 技能/)
  assert.match(p, /dws 技能/)
  assert.match(p, /不直接联系其他编码智能体/)
  assert.match(p, /结束时直接给出最终回复/)
  assert.match(p, /直接给出最终回复/)
  assert.doesNotMatch(p, /<RESULT>/, "不再要求结构化 RESULT 协议")
  assert.doesNotMatch(p, /push、开 PR、合并、关工单、动 worktree 由外部流程接手/)
})

test("resume 保持编码智能体交付边界，并接续审查修复", () => {
  const p = resume({
    issue: { number: 255, title: "沙盒模式" },
    attempt: 2,
    repo: "yyzl/win-ai-harness",
    workspaces: [{ repo: "yyzl/win-ai-harness", worktree: "/tmp/wt", branch: "fix/issue-255" }],
    failure: "审查发现缺少异常分支测试",
  })
  assert.match(p, /只允许推送到派单指定的非保护工作分支/)
  assert.match(p, /按对抗审查意见修复/)
  assert.match(p, /更新原 PR/)
  assert.match(p, /不合并 PR/)
  assert.doesNotMatch(p, /push、开 PR、合并、关工单、worktree 由外部流程接手/)
})

test("kickoff 多工程：每个工程一条工作区、一条 PR，关联原工单", () => {
  const p = kickoff({
    repo: "yyzl/win-ai-harness",
    issue: { number: 284, title: "镜像页", body: "改 win-ai-harness/web 与 yyjz-oa-frontend/apps/admin" },
    base: "sit-20261126",
    workspaces: [
      { repo: "yyzl/win-ai-harness", branch: "fix/issue-284", base: "sit-20261126", worktree: "/w/win-ai-harness/fix-issue-284" },
      { repo: "yyzl/yyjz-oa-frontend", branch: "fix/issue-284", base: "sit-20261126", worktree: "/w/yyjz-oa-frontend/fix-issue-284" },
    ],
    failedWorkspaces: [{ repo: "yyzl/yyjz-oa-cloud", error: "不是 git 仓库" }],
  })
  assert.match(p, /本单 2 个工程/)
  assert.match(p, /1\. yyzl\/win-ai-harness[\s\S]*工作区：\/w\/win-ai-harness\/fix-issue-284/)
  assert.match(p, /2\. yyzl\/yyjz-oa-frontend[\s\S]*工作区：\/w\/yyjz-oa-frontend\/fix-issue-284/)
  assert.match(p, /yyjz-oa-cloud：不是 git 仓库/)
  assert.match(p, /缺工作区：<owner\/name>/)
  assert.match(p, /每个动过的工程分别 push 并开 PR/)
  assert.match(p, /--issue-repo/)
  assert.match(p, /不合并 PR/)
})

test("RESULT 的 prs[]：一个工程一条，顺便补 pr / prUrl", () => {
  const r = parseResult(
    '<RESULT>{"status":"done","prs":[{"repo":"yyzl/win-ai-harness","branch":"fix/issue-284","pr":290,"prUrl":"http://g/win-ai-harness/pulls/290"},{"repo":"yyzl/yyjz-oa-frontend","branch":"fix/issue-284","pr":300,"prUrl":"http://g/yyjz-oa-frontend/pulls/300"}],"tests":"两边单测通过","summary":"镜像页"}</RESULT>'
  )
  assert.equal(r.status, "done")
  assert.equal(r.prs.length, 2)
  assert.deepEqual(r.prs.map((p) => p.repo), ["yyzl/win-ai-harness", "yyzl/yyjz-oa-frontend"])
  assert.equal(r.pr, 290)
  assert.equal(r.prUrl, "http://g/win-ai-harness/pulls/290")
  assert.equal(r.branch, "fix/issue-284")
})
