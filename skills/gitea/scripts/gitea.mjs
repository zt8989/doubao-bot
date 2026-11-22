#!/usr/bin/env node
// 包装 gitea CLI：解软链、优先跑仓库里的 gitea 包，其次跑全局 gitea。全平台可用
// （Windows/macOS/Linux），用法：node gitea.mjs pr-view 217 --repo yyzl/win-ai-harness
import { existsSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"

const args = process.argv.slice(2)

// 技能可能被软链到 ~/Doubao/skills/gitea，脚本也可能从 dist 发布产物里跑；
// realpath 解开软链/junction，再向上逐级找 gitea/bin/gitea.mjs
// （源码是 doubao-bot/gitea，发布后是 dist/gitea）。
const self = realpathSync(fileURLToPath(import.meta.url))
let dir = dirname(self)
let cli = ""
for (let i = 0; i < 8 && dir !== dirname(dir); i += 1) {
  const candidate = join(dir, "gitea", "bin", "gitea.mjs")
  if (existsSync(candidate)) {
    cli = candidate
    break
  }
  dir = dirname(dir)
}

if (cli) {
  const run = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" })
  process.exit(run.status ?? 1)
}

// 兜底：PATH 里的全局 gitea（npm link 装的；Windows 上 npm 生成 gitea.cmd 垫片）
const global = whichGlobalGitea()
if (global) {
  const isShim = /\.(cmd|bat)$/i.test(global)
  const run = isShim
    ? spawnSync(`"${global}" ${args.map(quoteCmd).join(" ")}`, {
        stdio: "inherit",
        shell: true,
      })
    : spawnSync(global, args, { stdio: "inherit" })
  process.exit(run.status ?? 1)
}

process.stdout.write(
  '{"ok":false,"error":{"code":"not_installed","message":"找不到 gitea CLI；先 scripts/publish.sh gitea 或 npm --prefix gitea link"}}\n',
)
process.exit(127)

// 手写 which：扫描 PATH 找 gitea 可执行文件（Windows 按 PATHEXT 补扩展名）
function whichGlobalGitea() {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
      : [""]
  for (const piece of (process.env.PATH ?? "").split(delimiter)) {
    if (!piece) continue
    for (const ext of exts) {
      const p = join(piece, `gitea${ext}`)
      try {
        if (statSync(p).isFile()) return p
      } catch {
        // 找不到就试下一个
      }
    }
  }
  return ""
}

// Windows shell:true 时给参数补引号，防参数里有空格被拆开
function quoteCmd(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg
}
