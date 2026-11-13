#!/usr/bin/env bash
# 把 foreman 的**已提交**代码发布到 dist/foreman，并 npm link 成全局 foreman 命令。
#
# 为什么：`npm link` 直接挂到源码目录时，工作区里未提交的改动会立刻作用到线上命令
# （常驻服务也会拿到半成品）。这里改成「发布产物」上线的口径：
#   改源码 → commit → scripts/publish-foreman.sh → 线上命令跑 dist 里那一份。
#
# 用法：scripts/publish-foreman.sh [--allow-dirty]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/foreman"
DST="$REPO/dist/foreman"
ALLOW_DIRTY=0
[ "${1:-}" = "--allow-dirty" ] && ALLOW_DIRTY=1

# 1) 只发布已提交的代码：foreman 目录有未提交改动就拒发（防止半成品上线）
DIRTY="$(git -C "$REPO" status --porcelain -- foreman)"
if [ -n "$DIRTY" ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
  echo "foreman 有未提交改动，先 commit（或加 --allow-dirty）：" >&2
  echo "$DIRTY" >&2
  exit 1
fi

COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
[ -z "$DIRTY" ] || COMMIT="$COMMIT-dirty"

# 2) 控制台先构建：服务从本地 console/dist 下发，不依赖 CDN
(cd "$SRC" && npm run build:console >/dev/null)

# 3) 重建 dist/foreman：只放运行时需要的（测试、console 源码、vite 配置都不发）
rm -rf "$DST"
mkdir -p "$DST/console"
cp -R "$SRC/bin" "$SRC/src" "$DST/"
cp "$SRC/package.json" "$SRC/README.md" "$DST/"
cp -R "$SRC/console/dist" "$DST/console/dist"

# 发布产物的 package.json 只留运行时字段（去掉 devDependencies 与开发脚本）
node -e '
const fs = require("node:fs")
const p = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
delete pkg.devDependencies
pkg.scripts = {}
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n")
' "$DST/package.json"

# 发布标记：线上跑的是哪次提交，一眼看得出来
cat > "$DST/PUBLISHED.json" <<JSON
{
  "commit": "$COMMIT",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$SRC"
}
JSON

# 4) 链接：全局 foreman 指向 dist（不再是源码目录），改源码不再立刻影响线上
(cd "$DST" && npm link >/dev/null)

echo "已发布：${DST}（commit ${COMMIT}）"
echo "全局命令：$(command -v foreman) -> $(readlink "$(command -v foreman)" 2>/dev/null || echo '?')"
