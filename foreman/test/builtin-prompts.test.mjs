import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { builtinAgentPromptPath, builtinPrompt } from "../src/builtin-prompts.mjs"

test("builtinAgentPromptPath：返回存在的岗位提示词绝对路径；未知名字报错", () => {
  for (const name of ["coder", "reviewer"]) {
    const p = builtinAgentPromptPath(name)
    assert.ok(path.isAbsolute(p), p)
    assert.ok(fs.existsSync(p), `文件应存在：${p}`)
    const text = fs.readFileSync(p, "utf8")
    assert.match(text, /岗位提示词/, `${p} 应是独立岗位提示词（自读形态）`)
    assert.ok(!text.trim().startsWith(">"), `${p} 不应再是 blockquote 注入模板`)
  }
  // coder 覆盖编码链路关键能力，reviewer 覆盖结构化 JSON 输出契约
  assert.match(fs.readFileSync(builtinAgentPromptPath("coder"), "utf8"), /foreman ws add/)
  assert.match(fs.readFileSync(builtinAgentPromptPath("coder"), "utf8"), /foreman pr open/)
  assert.match(fs.readFileSync(builtinAgentPromptPath("reviewer"), "utf8"), /"conclusion": "blocking\|non_blocking"/)
  assert.throws(() => builtinAgentPromptPath("nope"), /未知的智能体提示词/)
})

test("builtinPrompt：router 提示词含 foreman 工作会话分配口径（与首句协议呼应）", () => {
  const prompt = builtinPrompt("router")
  assert.match(prompt, /foreman session open/)
  assert.match(prompt, /独立工作会话/)
  assert.match(prompt, /子智能体分配协议/)
  assert.doesNotMatch(prompt, /CreateSession/)
})
