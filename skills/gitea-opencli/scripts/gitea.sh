#!/usr/bin/env bash
# 包装 opencli gitea：修正 PATH、返回干净 JSON。
# 用法：bash gitea.sh pr-view 217 --repo yyzl/win-ai-harness
set -uo pipefail

OPENCLI_BIN_DIR="${OPENCLI_BIN_DIR:-$HOME/.nvm/versions/node/v22.21.1/bin}"
export PATH="$OPENCLI_BIN_DIR:$PATH"

if ! command -v opencli >/dev/null 2>&1; then
  printf '{"ok":false,"error":"opencli not found; set OPENCLI_BIN_DIR"}'
  exit 127
fi

out=$(opencli gitea "$@" 2>&1)
rc=$?

printf '%s' "$out" | python3 -c '
import sys, json
raw = sys.stdin.read()
start, end = raw.find("{"), raw.rfind("}")
if start < 0 or end < 0:
    print(raw.strip())
    sys.exit(0)
chunk = raw[start:end + 1]
try:
    print(json.dumps(json.loads(chunk), ensure_ascii=False, indent=2))
except Exception:
    print(chunk)
'

exit $rc
