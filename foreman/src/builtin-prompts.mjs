// 内置编排提示词：唯一编排会话、派单会话、合并会话各一份，随代码走（src/builtin/*.md）。
// 配置里 sessionFlow.promptFile / deliver.promptFile / products[].promptFile 留空时就用这里的，
// 提示词和编排逻辑同版本、同评审——不再靠 ~/.foreman/prompts 下的运行时副本。
import fs from "node:fs"

const FILES = {
  orchestrator: "orchestrator-prompt.md",
  dispatch: "dispatch-prompt.md",
  merge: "merge-prompt.md",
}

const cache = new Map()

export const BUILTIN_PROMPT_LANES = Object.keys(FILES)

export function builtinPrompt(lane = "dispatch") {
  const key = lane === "orchestrator" || lane === "merge" ? lane : "dispatch"
  const hit = cache.get(key)
  if (hit) return hit
  const file = new URL(`./builtin/${FILES[key]}`, import.meta.url)
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    throw new Error(`读不到内置提示词 ${FILES[key]}：${e.message}`)
  }
  if (!text.trim()) throw new Error(`内置提示词是空文件：${FILES[key]}`)
  cache.set(key, text)
  return text
}
