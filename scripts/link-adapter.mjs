#!/usr/bin/env node
// 把 **已发布** 的 gitea 适配器挂到 opencli 能认的位置（可重复执行）。
// （原 scripts/link-adapter.sh 的跨平台 Node 版）
// 适配器是 REST 版（adapters/gitea/*.js 直接 import ../../gitea/src/api.mjs），不再驱动浏览器，
// 令牌走 ~/.foreman/gitea-token。
//
// 为什么要文件级挂载：opencli 的发现逻辑是 readdir(clis, {withFileTypes}) 后
// 只保留 entry.isDirectory()，目录链接会被直接跳过（整条 gitea 命令会消失）。
// 所以 ~/.opencli/clis/gitea 必须是真目录，里面的 .js 逐个指到发布产物
// （POSIX 软链；Windows 直接复制——文件软链要特权，发布脚本每次都会重挂，复制即等效）。
//
// 链的是 dist/adapters/gitea，不是 adapters/gitea 源码：开发时改源码不会立刻作用到
// 线上 opencli gitea 命令；要上线先 node scripts/publish.mjs adapters。
//
// 另外适配器 import 的是 `@jackwener/opencli/registry`，Node 按真实路径解析：
// dist/adapters/gitea/*.js 向上找到仓库 node_modules/@jackwener/opencli（指向全局包）。
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const WIN = process.platform === "win32"

// PATH+PATHEXT 里找命令，找到给全路径，找不到给 ""（等价 command -v）。
// Windows 先试 PATHEXT：裸名文件是 npm 给 Git Bash 用的 sh 垫片，CreateProcess 跑不了。
function which(name) {
  const exts = WIN ? [...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"), ""] : [""]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch {}
    }
  }
  return ""
}

function quoteWinArg(arg) {
  return /[\s"]/.test(arg) ? `"${String(arg).replaceAll('"', '\\"')}"` : String(arg)
}

function runOpencli(opencli, args) {
  if (WIN && /\.(cmd|bat)$/i.test(opencli)) {
    return spawnSync([opencli, ...args].map(quoteWinArg).join(" "), { shell: true, encoding: "utf8" })
  }
  return spawnSync(opencli, args, { encoding: "utf8" })
}

// 定位全局 @jackwener/opencli 包根：优先 npm root -g；POSIX 还可从入口 readlink 反推
function resolveOpencliPkg(opencli) {
  try {
    const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim()
    if (root) {
      const pkg = path.join(root, "@jackwener", "opencli")
      if (fs.existsSync(pkg)) return pkg
    }
  } catch {}
  if (!WIN) {
    try {
      return path.resolve(path.dirname(fs.realpathSync(opencli)), "..", "..")
    } catch {}
  }
  throw new Error("找不到全局 @jackwener/opencli 包（npm root -g 下没有）")
}

// opencli list gitea -f json 的输出可能混噪声：取首个 { 到末个 } 再解析
function countCommands(stdout) {
  const s = String(stdout ?? "")
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start < 0 || end <= start) return 0
  try {
    const d = JSON.parse(s.slice(start, end + 1))
    return (d?.data?.commands ?? []).length
  } catch {
    return 0
  }
}

// 单文件挂载：优先软链（开发者模式下语义与 POSIX 一致）。无软链特权（EPERM）时复制，
// 并把指向 dist/gitea 的相对导入改写成 file URL——复制后文件真实位置变了，
// `../../gitea` 会落到 ~/.opencli 下找不到（macOS 靠软链 + realpath 天然没这个问题）。
function mountFile(from, to, giteaUrl) {
  fs.rmSync(to, { force: true })
  if (!WIN) {
    fs.symlinkSync(from, to)
    return
  }
  try {
    fs.symlinkSync(from, to, "file")
    return
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EACCES") throw e
  }
  const code = fs
    .readFileSync(from, "utf8")
    .replaceAll("'../../gitea/", `'${giteaUrl}/`)
    .replaceAll('"../../gitea/', `"${giteaUrl}/`)
  fs.writeFileSync(to, code)
}

export function linkAdapters({ log = console.log } = {}) {
  const src = process.env.ADAPTER_SRC || path.join(REPO, "dist", "adapters", "gitea")
  const dst = path.join(process.env.OPENCLI_CLIS_DIR || path.join(os.homedir(), ".opencli", "clis"), "gitea")
  if (!fs.existsSync(src)) {
    throw new Error(`找不到适配器发布产物：${src}（先跑 node scripts/publish.mjs adapters）`)
  }
  const opencli = which("opencli")
  if (!opencli) throw new Error("PATH 里没有 opencli")

  // 1) 让适配器的 import 能解析到全局包
  const pkg = resolveOpencliPkg(opencli)
  fs.mkdirSync(path.join(REPO, "node_modules", "@jackwener"), { recursive: true })
  const shim = path.join(REPO, "node_modules", "@jackwener", "opencli")
  fs.rmSync(shim, { recursive: true, force: true })
  fs.symlinkSync(pkg, shim, WIN ? "junction" : "dir")
  log(`shim: node_modules/@jackwener/opencli -> ${pkg}`)

  // 2) 真目录 + 每个文件指到发布产物；仓库里已删掉的文件的旧挂载顺手清掉
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(dst)) {
    if (entry === "node_modules") continue
    if (!fs.existsSync(path.join(src, entry))) fs.rmSync(path.join(dst, entry), { force: true })
  }
  const giteaUrl = pathToFileURL(path.resolve(src, "..", "..", "gitea")).href
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith(".js")) continue
    mountFile(path.join(src, f), path.join(dst, f), giteaUrl)
  }
  // 复制模式下 bare import（@jackwener/opencli/...）从文件真实位置向上找不到包：
  // 在挂载目录里补一份 node_modules shim（软链模式下这份也无害，仓库里的 shim 照常生效）。
  if (WIN) {
    const nm = path.join(dst, "node_modules", "@jackwener")
    fs.mkdirSync(nm, { recursive: true })
    fs.rmSync(path.join(nm, "opencli"), { recursive: true, force: true })
    fs.symlinkSync(pkg, path.join(nm, "opencli"), "junction")
  }
  log(`adapter: ${dst}/*.js -> ${src}/*.js`)

  // 3) 自检：opencli 必须还能列出 gitea 命令
  const r = runOpencli(opencli, ["list", "gitea", "-f", "json"])
  const total = countCommands(r.stdout)
  if (total <= 0) throw new Error("警告：opencli 没列出 gitea 命令，检查上面的链接")
  log(`ok: opencli 认到 gitea 命令 ${total} 条`)
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    linkAdapters()
  } catch (e) {
    console.error(String(e.message ?? e))
    process.exit(1)
  }
}
