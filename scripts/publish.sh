#!/usr/bin/env bash
# 把 doubao-bot 里所有可上线的东西发布到 dist/，再把链接指到 dist（不再指源码）。
#
#   bin（npm link 装到全局）：gitea、foreman、dws
#   adapter（文件软链到 ~/.opencli/clis/gitea）：adapters/gitea/*.js（REST 版）
#   skill（软链到 ~/Doubao/skills）：skills/ 下的每个技能目录
#
# 口径：改源码 → commit → 本脚本 → 线上才变。工作区脏的单元默认不发布（防止半成品上线）。
# 用法：scripts/publish.sh [--allow-dirty] [gitea|adapters|foreman|dws|skills ...]（不给单元就是全部）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/dist"
SKILLS_LINK="${DOUBAO_SKILLS_DIR:-$HOME/Doubao/skills}"
ALLOW_DIRTY=0
UNITS=()

for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    gitea|adapters|foreman|dws|skills) UNITS+=("$arg") ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "不认识的单元：$arg（只有 gitea / adapters / foreman / dws / skills）" >&2; exit 1 ;;
  esac
done
[ "${#UNITS[@]}" -gt 0 ] || UNITS=(gitea adapters foreman dws skills)

COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
MANIFEST="$DIST/MANIFEST.json"
mkdir -p "$DIST"

# 单元脏了就跳过（--allow-dirty 时才照发）。只看该单元自己的目录。
dirty_of() { git -C "$REPO" status --porcelain -- "$1"; }
skip_if_dirty() {
  local path="$1" name="$2"
  local dirt
  dirt="$(dirty_of "$path")"
  if [ -n "$dirt" ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
    echo "跳过 ${name}：有未提交改动（先 commit，或加 --allow-dirty）" >&2
    echo "$dirt" | sed 's/^/  /' >&2
    return 1
  fi
  return 0
}

# 发布一个 npm 包：只带运行时需要的，然后 npm link 到全局。
publish_bin() {
  local name="$1"; shift
  local src="$REPO/$name" dst="$DIST/$name"
  skip_if_dirty "$name" "$name" || return 1

  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$src/bin" "$src/src" "$dst/"
  cp "$src/package.json" "$dst/"
  [ -f "$src/README.md" ] && cp "$src/README.md" "$dst/"
  for extra in "$@"; do [ -e "$src/$extra" ] && cp -R "$src/$extra" "$dst/"; done

  # foreman 的控制台由 Vite 构建，服务从本地 console/dist 下发（不依赖 CDN）
  if [ "$name" = "foreman" ]; then
    (cd "$src" && npm run build:console >/dev/null)
    mkdir -p "$dst/console"
    cp -R "$src/console/dist" "$dst/console/dist"
  fi

  # 发布产物的 package.json 只留运行时字段
  node -e '
const fs = require("node:fs")
const p = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
delete pkg.devDependencies
pkg.scripts = {}
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n")
' "$dst/package.json"

  # bin 入口要可执行，否则 npm link 出来的命令会 Permission denied
  chmod +x "$dst/bin/"*.mjs 2>/dev/null || true

  printf '{\n  "commit": "%s",\n  "at": "%s",\n  "source": "%s"\n}\n' \
    "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$src" > "$dst/PUBLISHED.json"

  (cd "$dst" && npm link >/dev/null)
  echo "已发布 bin：${name} → ${dst}（全局 $(command -v "$name")）"
}

# 发布 skills/ 下的每个技能目录，再逐个软链到豆包技能目录。
publish_skills() {
  skip_if_dirty "skills" "skills" || return 1
  mkdir -p "$DIST/skills" "$SKILLS_LINK"
  for dir in "$REPO"/skills/*/; do
    local name dst
    name="$(basename "$dir")"
    dst="$DIST/skills/$name"
    rm -rf "$dst"
    cp -R "$dir" "$dst"
    # bin 入口要可执行，否则 npm link 出来的命令会 Permission denied
  chmod +x "$dst/bin/"*.mjs 2>/dev/null || true

  printf '{\n  "commit": "%s",\n  "at": "%s",\n  "source": "%s"\n}\n' \
      "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${dir%/}" > "$dst/PUBLISHED.json"
    ln -sfn "$dst" "$SKILLS_LINK/$name"
    echo "已发布 skill：${name} → ${dst}（链接 ${SKILLS_LINK}/${name}）"
  done

  # 源码里已经删掉的技能：连 dist 和链接一起收掉，别让线上还挂着旧技能
  for old in "$DIST"/skills/*/; do
    [ -d "$old" ] || continue
    name="$(basename "$old")"
    [ -d "$REPO/skills/$name" ] && continue
    rm -rf "$old"
    echo "已收掉旧 skill：${name}"
  done
  for link in "$SKILLS_LINK"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$DIST"/skills/*) [ -e "$link" ] || { rm -f "$link"; echo "已收掉旧链接：${link}"; } ;;
    esac
  done
}

# 发布 opencli 适配器：拷源码到 dist/adapters/gitea，再把 ~/.opencli/clis/gitea 逐文件软链过去。
# 适配器是 REST 版，import 的是 dist/gitea/src/api.mjs（所以发布 adapters 会先发 gitea）。
publish_adapters() {
  skip_if_dirty "adapters" "adapters" || return 1
  local src="$REPO/adapters/gitea" dst="$DIST/adapters/gitea"
  [ -d "$src" ] || { echo "找不到适配器源码：$src" >&2; return 1; }

  rm -rf "$dst"
  mkdir -p "$dst"
  cp "$src"/*.js "$dst/"

  # bin 入口要可执行，否则 npm link 出来的命令会 Permission denied
  chmod +x "$dst/bin/"*.mjs 2>/dev/null || true

  printf '{\n  "commit": "%s",\n  "at": "%s",\n  "source": "%s"\n}\n' \
    "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$src" > "$dst/PUBLISHED.json"

  bash "$REPO/scripts/link-adapter.sh"
  echo "已发布 adapters：${dst} → ${HOME}/.opencli/clis/gitea"
}

PUBLISHED=()
for unit in "${UNITS[@]}"; do  case "$unit" in
    gitea) publish_bin gitea && PUBLISHED+=("gitea") ;;
    adapters)
      # 适配器 import 的是 dist/gitea/src/api.mjs，发布 adapters 必须带 gitea。
      if [[ " ${PUBLISHED[*]:-} " != *" gitea "* ]]; then
        publish_bin gitea && PUBLISHED+=("gitea")
      fi
      publish_adapters && PUBLISHED+=("adapters")
      ;;
    foreman)
      # foreman/src/gitea.mjs 直接 import ../../gitea/src/api.mjs，发布 foreman 必须带 gitea。
      if [[ " ${PUBLISHED[*]:-} " != *" gitea "* ]]; then
        publish_bin gitea && PUBLISHED+=("gitea")
      fi
      publish_bin foreman && PUBLISHED+=("foreman")
      ;;
    dws) publish_bin dws config.example.json && PUBLISHED+=("dws") ;;
    skills) publish_skills && PUBLISHED+=("skills") ;;
  esac
done

# 发布台账：dist 里现在跑的是哪次提交、哪些单元
node -e '
const fs = require("node:fs")
const [file, commit, units] = process.argv.slice(1)
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { units: {} }
prev.commit = commit
prev.at = new Date().toISOString()
prev.units = prev.units || {}
for (const u of units.split(",").filter(Boolean)) {
  prev.units[u] = { at: prev.at, commit }
}
fs.writeFileSync(file, JSON.stringify(prev, null, 2) + "\n")
' "$MANIFEST" "$COMMIT" "$(IFS=,; echo "${PUBLISHED[*]:-}")"

echo
echo "dist 位置：$DIST"
echo "本次发布：${PUBLISHED[*]:-（无，都脏或都跳过了）}"
echo "提交：$COMMIT"
