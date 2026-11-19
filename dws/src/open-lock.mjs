// dws open / msg 的跨进程互斥：豆包只有一个窗口，新建任务与切会话投递必须串行。
// macOS 自带 shlock：锁文件记录 PID；持有进程异常退出后，下一次 shlock 会自动回收死锁。
import fs from "node:fs"
import path from "node:path"
import { exec, sleep } from "./util.mjs"

export async function acquireOpenLock(file, {
  bin = "/usr/bin/shlock",
  retryMs = 200,
  timeoutMs = 60 * 60 * 1000,
  onWait = () => {},
} = {}) {
  const target = path.resolve(String(file))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const startedAt = Date.now()
  let waiting = false
  let lastError = null
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await exec(bin, ["-f", target, "-p", String(process.pid)], { timeout: 5000 })
      let released = false
      return {
        release() {
          if (released) return
          released = true
          try {
            const owner = fs.readFileSync(target, "utf8").trim().split(/\s+/)[0]
            if (owner === String(process.pid)) fs.rmSync(target, { force: true })
          } catch {}
        },
      }
    } catch (e) {
      lastError = e
      if (e.code !== 1) {
        throw new Error(`无法使用 dws 窗口操作锁 ${target}：${e.message}`, { cause: e })
      }
      if (!waiting) {
        waiting = true
        onWait()
      }
      await sleep(retryMs)
    }
  }
  throw new Error(`等待 dws 窗口操作锁超时：${target}。可能有另一条 dws open / msg 仍在运行。`, { cause: lastError })
}
