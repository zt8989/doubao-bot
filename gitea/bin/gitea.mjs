#!/usr/bin/env node
// gitea：内网 Gitea REST API 的 CLI 入口。
import { main } from "../src/cli.mjs"

main(process.argv.slice(2)).catch((e) => {
  const err = {
    ok: false,
    error: {
      code: e?.code ?? "gitea_error",
      message: String(e?.message ?? e),
    },
  }
  process.stdout.write(`${JSON.stringify(err, null, 2)}\n`)
  process.exitCode = 1
})
