// Schedule 执行器配置：页面展示、持久化与实际运行共用同一份定义。
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { builtinPrompt } from "../builtin-prompts.mjs"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// 入口脚本按绝对路径回导这个包：FOREMAN_HOME 指向当前运行副本（dist 或源码），
// 转发脚本 import 到的就是同一个模块实例，不会另起一份、把 Book 之类的类判断串掉。
process.env.FOREMAN_HOME ??= PACKAGE_ROOT

// 脚本型定时任务的入口脚本不在包内：单独一个目录、单独做本地版本，由 foreman 按绝对路径加载。
// 换机器/换目录用环境变量 FOREMAN_SCHEDULE_DIR 覆盖。
export const SCHEDULE_SCRIPT_DIR = String(
  process.env.FOREMAN_SCHEDULE_DIR || "/Users/zhouteng/Documents/workspace/doubao-bot/schedules"
).replace(/\/+$/, "")

const SCRIPT_DEFAULTS = {
  pickup: { path: `${SCHEDULE_SCRIPT_DIR}/pickup.mjs`, exportName: "pickupPollOnce", args: {} },
  prWatch: { path: `${SCHEDULE_SCRIPT_DIR}/prwatch.mjs`, exportName: "prPollOnce", args: {} },
  mail: { path: `${SCHEDULE_SCRIPT_DIR}/mail.mjs`, exportName: "mailPollOnce", args: {} },
  router: { path: `${SCHEDULE_SCRIPT_DIR}/router.mjs`, exportName: "pollOnce", args: {} },
}

const object = (value) => value && typeof value === "object" && !Array.isArray(value)

export function scriptExecutor(cfg, id) {
  const fallback = SCRIPT_DEFAULTS[id]
  if (!fallback) throw new Error(`${id} 不是脚本执行器`)
  const configured = object(cfg?.[id]?.script) ? cfg[id].script : {}
  return {
    path: String(configured.path ?? fallback.path).trim() || fallback.path,
    exportName: String(configured.exportName ?? fallback.exportName).trim() || fallback.exportName,
    args: object(configured.args) ? { ...configured.args } : {},
  }
}

export function normalizeScriptExecutor(value, cfg, id) {
  if (!object(value)) throw new Error(`${id} 的 script 必须是对象`)
  const current = scriptExecutor(cfg, id)
  const pathValue = String(value.path ?? current.path).trim()
  const exportName = String(value.exportName ?? current.exportName).trim()
  const args = value.args ?? current.args
  if (!pathValue) throw new Error("脚本路径不能为空")
  if (!exportName) throw new Error("脚本导出函数不能为空")
  if (!object(args)) throw new Error("脚本参数必须是 JSON 对象")
  return { path: pathValue, exportName, args: { ...args } }
}

export function agentExecutor(cfg) {
  const configured = object(cfg?.router?.agent) ? cfg.router.agent : {}
  const customPrompt = String(configured.prompt ?? "")
  return {
    prompt: customPrompt.trim() ? customPrompt : builtinPrompt("router"),
    custom: Boolean(customPrompt.trim()),
  }
}

export function normalizeAgentExecutor(value) {
  if (!object(value)) throw new Error("router 的 agent 必须是对象")
  if ("prompt" in value && typeof value.prompt !== "string") throw new Error("Agent 提示词必须是字符串")
  // 空字符串表示恢复内置提示词；非空内容原样保留，避免破坏 Markdown 缩进。
  return { prompt: String(value.prompt ?? "") }
}

export async function runConfiguredScript(ctx, id, { manual = false } = {}) {
  const definition = scriptExecutor(ctx.cfg, id)
  const file = path.isAbsolute(definition.path)
    ? definition.path
    : path.resolve(PACKAGE_ROOT, definition.path)
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    throw new Error(`加载定时脚本失败 ${definition.path}：${error.message}`)
  }
  const run = module[definition.exportName]
  if (typeof run !== "function") {
    throw new Error(`定时脚本 ${definition.path} 没有导出函数 ${definition.exportName}`)
  }
  const args = ["prWatch", "pickup"].includes(id) ? { ...definition.args, force: manual } : { ...definition.args }
  return run(ctx, args)
}
