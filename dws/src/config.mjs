// 配置：只放会话相关的东西（状态文件、模式、轮询与超时）。工单/仓库/PR 不归 dws 管。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expandHome } from "./util.mjs"

export const MESSAGE_MODES = new Set(["steer", "queue"])

export const DEFAULTS = {
  stateFile: ".dws/state.json",
  mode: "local",
  model: "auto",
  // 发消息的默认模式（steer | queue）。Enter 永远对应默认模式，Command+Enter 对应另一个：
  //   messageMode=steer（默认）→ Enter = steer（插进当前这一轮），Command+Enter = queue（排到这一轮之后）
  //   messageMode=queue         → Enter = queue，Command+Enter = steer
  messageMode: "steer",
  pollSeconds: 4,
  idleMinutes: 6,
  timeoutMinutes: 45,
}

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.code = "config_error"
  }
}

export function configPath(explicit) {
  if (explicit) return path.resolve(expandHome(explicit))
  for (const c of [
    path.join(process.cwd(), "config.json"),
    path.join(os.homedir(), ".dws", "config.json"),
  ]) {
    if (fs.existsSync(c)) return c
  }
  return path.join(process.cwd(), "config.json")
}

export function loadConfig(explicit) {
  const file = configPath(explicit)
  if (!fs.existsSync(file)) {
    throw new ConfigError(`找不到配置：${file}（可以先 cp config.example.json config.json）`)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    throw new ConfigError(`配置不是合法 JSON：${file}（${e.message}）`)
  }
  const dir = path.dirname(file)
  const config = merge(DEFAULTS, pick(raw))
  config.dir = dir
  config.path = file
  config.stateFile = path.resolve(dir, expandHome(config.stateFile))
  validate(config)
  return config
}

// 只认会话相关的键：工单/PR/仓库那套配置已经不归 dws 管，出现也不读。
const SESSION_KEYS = ["stateFile", "mode", "model", "messageMode", "pollSeconds", "idleMinutes", "timeoutMinutes"]

function pick(raw) {
  const out = {}
  for (const k of SESSION_KEYS) {
    if (raw?.[k] !== undefined) out[k] = raw[k]
  }
  return out
}

function merge(base, extra) {
  return { ...base, ...(extra ?? {}) }
}

function validate(config) {
  const numbers = ["pollSeconds", "idleMinutes", "timeoutMinutes"]
  for (const k of numbers) {
    if (typeof config[k] !== "number" || !(config[k] > 0)) {
      throw new ConfigError(`${k} 要是正数：${JSON.stringify(config[k])}`)
    }
  }
  if (!config.stateFile) throw new ConfigError("stateFile 不能为空")
  if (!MESSAGE_MODES.has(config.messageMode)) {
    throw new ConfigError(`messageMode 只能是 steer / queue：${JSON.stringify(config.messageMode)}`)
  }
}

export function repoConfig(config, key) {
  return config.repos.find((r) => r.name === key || r.repo === key) ?? null
}
