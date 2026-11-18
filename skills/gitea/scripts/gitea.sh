#!/usr/bin/env bash
# 包装 gitea REST CLI：修 PATH、优先跑仓库里的 gitea 包，其次跑全局 gitea。
# 用法：bash gitea.sh pr-view 217 --repo yyzl/win-ai-harness
set -uo pipefail

NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v22.21.1/bin}"
export PATH="$NODE_BIN_DIR:$PATH"

# 技能可能被软链到 ~/Doubao/skills/gitea，脚本也可能从 dist 发布产物里跑；
# 用 cd -P 解开软链，再向上找包根（源码是 doubao-bot/gitea，发布后是 dist/gitea）。
SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -P "$SELF_DIR/../../.." >/dev/null 2>&1 && pwd -P)"
CLI="$REPO_ROOT/gitea/bin/gitea.mjs"

if [ -f "$CLI" ]; then
  exec node "$CLI" "$@"
fi
if command -v gitea >/dev/null 2>&1; then
  exec gitea "$@"
fi
printf '{"ok":false,"error":{"code":"not_installed","message":"找不到 gitea CLI；先 scripts/publish.sh gitea 或 npm --prefix gitea link"}}\n'
exit 127
