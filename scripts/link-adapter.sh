#!/usr/bin/env bash
# 把 **已发布** 的 gitea 适配器挂到 opencli 能认的位置（可重复执行）。
# 适配器是 REST 版（adapters/gitea/*.js 直接 import ../../gitea/src/api.mjs），不再驱动浏览器，
# 令牌走 ~/.foreman/gitea-token。
#
# 为什么要文件级软链：opencli 的发现逻辑是 readdir(clis, {withFileTypes}) 后
# 只保留 entry.isDirectory()，目录软链会被直接跳过（整条 gitea 命令会消失）。
# 所以 ~/.opencli/clis/gitea 必须是真目录，里面的 .js 逐个软链到发布产物。
#
# 链的是 dist/adapters/gitea，不是 adapters/gitea 源码：开发时改源码不会立刻作用到
# 线上 opencli gitea 命令；要上线先 scripts/publish.sh adapters。
#
# 另外适配器 import 的是 `@jackwener/opencli/registry`，Node 按真实路径解析：
# dist/adapters/gitea/*.js 向上找到仓库 node_modules/@jackwener/opencli（指向全局包）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ADAPTER_SRC:-$REPO/dist/adapters/gitea}"
DST="${OPENCLI_CLIS_DIR:-$HOME/.opencli/clis}/gitea"

[ -d "$SRC" ] || { echo "找不到适配器发布产物：$SRC（先跑 scripts/publish.sh adapters）" >&2; exit 1; }
command -v opencli >/dev/null || { echo "PATH 里没有 opencli" >&2; exit 1; }

# 1) 让适配器的 import 能解析到全局包
ENTRY="$(readlink -f "$(command -v opencli)")"
PKG="$(cd "$(dirname "$ENTRY")/../.." && pwd)"
mkdir -p "$REPO/node_modules/@jackwener"
ln -sfn "$PKG" "$REPO/node_modules/@jackwener/opencli"
echo "shim: node_modules/@jackwener/opencli -> $PKG"

# 2) 真目录 + 每个文件软链到发布产物
mkdir -p "$DST"
# 清掉仓库里已经删掉的文件的旧链接
for old in "$DST"/*; do
  [ -e "$old" ] || [ -L "$old" ] || continue
  base="$(basename "$old")"
  [ -e "$SRC/$base" ] || rm -f "$old"
done
for f in "$SRC"/*; do
  ln -sfn "$f" "$DST/$(basename "$f")"
done
echo "adapter: $DST/*.js -> $SRC/*.js"

# 3) 自检：opencli 必须还能列出 gitea 命令
out="$(opencli list gitea -f json 2>/dev/null || true)"
total="$(printf '%s' "$out" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(len((d.get("data") or {}).get("commands") or []))
except Exception:
    print(0)' 2>/dev/null || echo 0)"
if [ "${total:-0}" -gt 0 ]; then
  echo "ok: opencli 认到 gitea 命令 $total 条"
else
  echo "警告：opencli 没列出 gitea 命令，检查上面的链接" >&2
  exit 1
fi
