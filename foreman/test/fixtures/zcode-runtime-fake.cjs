#!/usr/bin/env node
// 假 zcode runtime cjs：只处理 --version（doctor 的 runtime 探活用），其余静默退出。
if (process.argv.includes("--version")) {
  console.log("zcode-runtime 0.18.0-fake")
}
