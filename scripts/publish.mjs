#!/usr/bin/env node
// 把 doubao-bot 里所有可上线的东西发布到 dist/，再把链接指到 dist（不再指源码）。
// （原 scripts/publish.sh 的跨平台 Node 版：目录链接 Windows 用 junction、POSIX 用 symlink；
//   适配器文件 Windows 复制、POSIX 软链。）
//
//   bin（npm link 装到全局）：gitea、foreman、dws
//   adapter（挂到 ~/.opencli/clis/gitea）：adapters/gitea/*.js（REST 版）
//   skill（链接到 ~/Doubao/skills 和 ~/.zcode/skills）：skills/ 下的每个技能目录
//
// 口径：改源码 → commit → 本脚本 → 线上才变。工作区脏的单元默认不发布（防止半成品上线）。
// 用法：node scripts/publish.mjs [--allow-dirty] [gitea|adapters|foreman|dws|skills ...]（不给单元就是全部）
import { spawnSync, execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { linkAdapters } from "./link-adapter.mjs"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST = path.join(REPO, "dist")
// 技能发布目标：豆包技能目录（DOUBAO_SKILLS_DIR 可覆盖）+ ZCode 用户技能目录 ~/.zcode/skills。
// ZCode 只认 description ≤1024 的技能，超限整条丢弃——发新技能前先看一眼描述长度。
const SKILLS_LINKS = [
  ...new Set([
    process.env.DOUBAO_SKILLS_DIR || path.join(os.homedir(), "Doubao", "skills"),
    path.join(os.homedir(), ".zcode", "skills"),
  ]),
]
const WIN = process.platform === "win32"
const UNITS = ["gitea", "adapters", "foreman", "dws", "skills"]

// —— 参数（口径与原 sh 一致；-h/--help 打印本注释头）——
const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help")) {
  const head = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 9).join("\n")
  console.log(head.replace(/^\/\/ ?/gm, ""))
  process.exit(0)
}
const allowDirty = argv.includes("--allow-dirty")
const wanted = argv.filter((a) => !a.startsWith("--"))
for (const w of wanted) {
  if (!UNITS.includes(w)) {
    console.error(`不认识的单元：${w}（只有 ${UNITS.join(" / ")}）`)
    process.exit(1)
  }
}
const units = wanted.length ? wanted : UNITS

const gitOut = (args) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout ?? ""
const COMMIT = gitOut(["rev-parse", "--short", "HEAD"]).trim()
fs.mkdirSync(DIST, { recursive: true })

// 单元脏了就跳过（--allow-dirty 时才照发）。只看该单元自己的目录。
function skipIfDirty(unit) {
  const dirt = gitOut(["status", "--porcelain", "--", unit]).trim()
  if (dirt && !allowDirty) {
    console.error(`跳过 ${unit}：有未提交改动（先 commit，或加 --allow-dirty）`)
    for (const line of dirt.split("\n")) console.error(`  ${line}`)
    return false
  }
  return true
}

const rmRf = (p) => fs.rmSync(p, { recursive: true, force: true })
const cpR = (src, dst) => fs.cpSync(src, dst, { recursive: true })

function chmodBins(dir) {
  if (WIN) return
  const bin = path.join(dir, "bin")
  if (!fs.existsSync(bin)) return
  for (const f of fs.readdirSync(bin)) {
    if (f.endsWith(".mjs")) fs.chmodSync(path.join(bin, f), 0o755)
  }
}

function writePublished(dir, src) {
  fs.writeFileSync(
    path.join(dir, "PUBLISHED.json"),
    JSON.stringify({ commit: COMMIT, at: new Date().toISOString(), source: src }, null, 2) + "\n",
  )
}

// 目录链接：Windows 用 junction（免管理员权限）；POSIX 用 symlink。可重复执行。
function linkDir(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.rmSync(linkPath, { recursive: true, force: true })
  fs.symlinkSync(target, linkPath, WIN ? "junction" : "dir")
}

// readlink 对 junction 会带回 \\?\ 前缀，比较前剥掉
const normalizeLinkTarget = (t) => String(t ?? "").replace(/^\\\\\?\\/, "")

// PATH+PATHEXT 里找全局命令，找不到给 ""（等价 command -v）。
// Windows 先试 PATHEXT：裸名文件是 npm 给 Git Bash 用的 sh 垫片，CreateProcess 跑不了。
function globalBinPath(name) {
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

// Windows 上 scoop-nvm 的全局命令经 .shim 目录转发，npm link 只写版本目录，
// 不 reshim 新命令就不在 PATH 里（nvm-windows 原生布局无此问题）。有 nvm 就顺手刷一次。
function reshimIfNeeded() {
  if (!WIN) return
  const r = spawnSync("nvm", ["reshim"], { encoding: "utf8", shell: false })
  if (r.status === 0) console.log("nvm reshim：全局垫片已刷新")
}

// 发布一个 npm 包：只带运行时需要的，然后 npm link 到全局。
function publishBin(name, extras = []) {
  if (!skipIfDirty(name)) return false
  const src = path.join(REPO, name)
  const dst = path.join(DIST, name)
  rmRf(dst)
  fs.mkdirSync(dst, { recursive: true })
  cpR(path.join(src, "bin"), path.join(dst, "bin"))
  cpR(path.join(src, "src"), path.join(dst, "src"))
  fs.copyFileSync(path.join(src, "package.json"), path.join(dst, "package.json"))
  const readme = path.join(src, "README.md")
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(dst, "README.md"))
  for (const extra of extras) {
    const p = path.join(src, extra)
    if (fs.existsSync(p)) cpR(p, path.join(dst, extra))
  }

  // foreman 的控制台由 Vite 构建，服务从本地 console/dist 下发（不依赖 CDN）
  if (name === "foreman") {
    execSync("npm run build:console", { cwd: src, stdio: ["ignore", "ignore", "inherit"] })
    cpR(path.join(src, "console", "dist"), path.join(dst, "console", "dist"))
  }

  // 发布产物的 package.json 只留运行时字段
  const pkgPath = path.join(dst, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  delete pkg.devDependencies
  pkg.scripts = {}
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")

  // bin 入口要可执行，否则 npm link 出来的命令会 Permission denied
  chmodBins(dst)
  writePublished(dst, src)
  // --force：全局同名垫片已存在时（Windows 上 npm link 会 EEXIST 拒绝）照常覆盖——这几个命令名归本脚本管。
  // npm link 不保证把 dependencies 装进发布目录（Windows 实测没装），先显式装运行时依赖。
  execSync("npm install --omit=dev --no-audit --no-fund", { cwd: dst, stdio: ["ignore", "pipe", "pipe"] })
  execSync("npm link --force", { cwd: dst, stdio: ["ignore", "pipe", "pipe"] })
  reshimIfNeeded()
  console.log(`已发布 bin：${name} → ${dst}（全局 ${globalBinPath(name) || name}）`)
  return true
}

// 发布 skills/ 下的每个技能目录，再逐个链接到豆包技能目录。
function publishSkills() {
  if (!skipIfDirty("skills")) return false
  fs.mkdirSync(path.join(DIST, "skills"), { recursive: true })
  for (const dir of SKILLS_LINKS) fs.mkdirSync(dir, { recursive: true })
  for (const entry of fs.readdirSync(path.join(REPO, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const src = path.join(REPO, "skills", name)
    const dst = path.join(DIST, "skills", name)
    rmRf(dst)
    cpR(src, dst)
    chmodBins(dst)
    writePublished(dst, src)
    for (const dir of SKILLS_LINKS) linkDir(dst, path.join(dir, name))
    console.log(`已发布 skill：${name} → ${dst}（链接 ${SKILLS_LINKS.map((d) => path.join(d, name)).join("、")}）`)
  }

  // 源码里已经删掉的技能：连 dist 和链接一起收掉，别让线上还挂着旧技能
  for (const entry of fs.readdirSync(path.join(DIST, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (!fs.existsSync(path.join(REPO, "skills", name))) {
      rmRf(path.join(DIST, "skills", name))
      console.log(`已收掉旧 skill：${name}`)
    }
  }
  for (const dir of SKILLS_LINKS) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue
      const link = path.join(dir, entry.name)
      let target = ""
      try {
        target = normalizeLinkTarget(fs.readlinkSync(link))
      } catch {}
      if (target.startsWith(path.join(DIST, "skills")) && !fs.existsSync(link)) {
        fs.rmSync(link, { force: true })
        console.log(`已收掉旧链接：${link}`)
      }
    }
  }
  return true
}

// 发布 opencli 适配器：拷源码到 dist/adapters/gitea，再把 ~/.opencli/clis/gitea 逐文件挂过去。
// 适配器是 REST 版，import 的是 dist/gitea/src/api.mjs（所以发布 adapters 会先发 gitea）。
function publishAdapters() {
  if (!skipIfDirty("adapters")) return false
  const src = path.join(REPO, "adapters", "gitea")
  const dst = path.join(DIST, "adapters", "gitea")
  if (!fs.existsSync(src)) {
    console.error(`找不到适配器源码：${src}`)
    return false
  }
  rmRf(dst)
  fs.mkdirSync(dst, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(src, f), path.join(dst, f))
  }
  writePublished(dst, src)
  linkAdapters()
  console.log(`已发布 adapters：${dst} → ${path.join(os.homedir(), ".opencli", "clis", "gitea")}`)
  return true
}

const published = []
const done = new Set()
const publishGiteaOnce = () => {
  if (!done.has("gitea") && publishBin("gitea")) {
    done.add("gitea")
    published.push("gitea")
  }
}
for (const unit of units) {
  switch (unit) {
    case "gitea":
      publishGiteaOnce()
      break
    case "adapters":
      // 适配器 import 的是 dist/gitea/src/api.mjs，发布 adapters 必须带 gitea。
      publishGiteaOnce()
      if (publishAdapters()) published.push("adapters")
      break
    case "foreman":
      // foreman/src/gitea.mjs 直接 import ../../gitea/src/api.mjs，发布 foreman 必须带 gitea。
      publishGiteaOnce()
      if (publishBin("foreman")) published.push("foreman")
      break
    case "dws":
      if (publishBin("dws", ["config.example.json"])) published.push("dws")
      break
    case "skills":
      if (publishSkills()) published.push("skills")
      break
  }
}

// 发布台账：dist 里现在跑的是哪次提交、哪些单元
const manifestPath = path.join(DIST, "MANIFEST.json")
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
} catch {
  manifest = { units: {} }
}
const at = new Date().toISOString()
manifest.commit = COMMIT
manifest.at = at
manifest.units = manifest.units ?? {}
for (const u of published) manifest.units[u] = { at, commit: COMMIT }
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

console.log(`\ndist 位置：${DIST}`)
console.log(`本次发布：${published.join(" ") || "（无，都脏或都跳过了）"}`)
console.log(`提交：${COMMIT}`)
