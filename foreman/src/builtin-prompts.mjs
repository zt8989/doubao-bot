// 内置提示词：编排、派单、合并与 router agent 各一份，随代码走（src/builtin/*.md）。
// 配置里 sessionFlow.promptFile / deliver.promptFile / products[].promptFile 留空时就用这里的，
// 提示词和编排逻辑同版本、同评审——不再靠 ~/.foreman/prompts 下的运行时副本。
// 另有 src/builtin/agents/*.md：按智能体拆分的岗位提示词（coder/reviewer），
// zcode 载体下 router 用 CreateSession 开独立子会话，把这里的绝对路径写进首句让子智能体自读。
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const FILES = {
  orchestrator: "orchestrator-prompt.md",
  dispatch: "dispatch-prompt.md",
  router: "router-prompt.md",
  merge: "merge-prompt.md",
}

// 子智能体岗位提示词：名字 → builtin/agents/<name>.md。
const AGENT_PROMPT_FILES = {
  coder: "agents/coder.md",
  reviewer: "agents/reviewer.md",
}

const cache = new Map()

export const BUILTIN_PROMPT_LANES = Object.keys(FILES)

export function builtinPrompt(lane = "dispatch") {
  const normalized = lane === "inspector" ? "router" : lane
  const key = ["orchestrator", "router", "merge"].includes(normalized) ? normalized : "dispatch"
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

// 子智能体岗位提示词的绝对路径：运行时算出（src/dist 各自成立），写进 router 首句
// 让独立子会话自读——delivered 会话没有 --cwd，提示词引用必须绝对路径。
export function builtinAgentPromptPath(name = "coder") {
  const file = AGENT_PROMPT_FILES[name]
  if (!file) throw new Error(`未知的智能体提示词：${name}（可选：${Object.keys(AGENT_PROMPT_FILES).join("、")}）`)
  const p = fileURLToPath(new URL(`./builtin/${file}`, import.meta.url))
  let ok = false
  try {
    ok = fs.statSync(p).isFile()
  } catch {}
  if (!ok) throw new Error(`智能体提示词文件不存在：${file}（期望在 ${p}）`)
  return p
}
