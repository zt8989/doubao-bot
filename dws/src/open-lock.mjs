// dws open / msg 的跨进程互斥：豆包只有一个窗口，新建任务与切会话投递必须串行。
// Node 原生锁，语义等同 macOS 的 shlock（锁文件记录持有者 PID；持有进程异常退出后，
// 下一次 acquire 会回收死锁），全平台一致。
import fs from "node:fs"
import path from "node:path"
import { sleep } from "./util.mjs"

// pidAlive 用 kill(pid, 0) 探活：ESRCH 是死了，EPERM 是活着但不归我们发信号。
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === "EPERM"
  }
}

// tryLock 试拿一次锁：wx 独占创建成功即拿到；文件已存在则看持有者，活着就让、
// 死了就接管。接管用 rename 原子夺走旧文件（并发回收时只有一家能 rename 成功），
// 再重建锁文件——先删后建会有两家都当选的竞态。
function tryLock(target) {
  try {
    fs.writeFileSync(target, String(process.pid), { flag: "wx" })
    return true
  } catch (e) {
    if (e.code !== "EEXIST") throw e
  }
  let owner = 0
  try {
    owner = Number.parseInt(fs.readFileSync(target, "utf8").trim().split(/\s+/)[0], 10)
  } catch {
    return false // 文件刚被释放或被并发回收，下一轮重试
  }
  if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) return false
  const stale = `${target}.${process.pid}.${Date.now()}.stale`
  try {
    fs.rmSync(stale, { force: true })
    fs.renameSync(target, stale) // ENOENT = 别人抢先把旧锁收走了
  } catch {
    return false
  }
  try {
    fs.writeFileSync(target, String(process.pid), { flag: "wx" })
  } catch {
    // 旧锁夺走后目标被并发重建：放弃这一轮，按正常流程走
    fs.rmSync(stale, { force: true })
    return false
  }
  fs.rmSync(stale, { force: true })
  return true
}

export async function acquireOpenLock(file, {
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
    if (tryLock(target)) {
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
    }
    lastError = lastError ?? new Error("锁被其他进程持有")
    if (!waiting) {
      waiting = true
      onWait()
    }
    await sleep(retryMs)
  }
  throw new Error(`等待 dws 窗口操作锁超时：${target}。可能有另一条 dws open / msg 仍在运行。`, { cause: lastError })
}
