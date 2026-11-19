import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { acquireOpenLock } from "../src/open-lock.mjs"
import { sleep } from "../src/util.mjs"
import { SessionBook, SessionManager } from "../src/sessions.mjs"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dws-open-lock-"))
  return {
    file: path.join(dir, "state.json.open.lock"),
    state: path.join(dir, "state.json"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test("并发 dws open 共用一把跨进程锁：第二个必须等第一个释放", async () => {
  const f = fixture()
  try {
    const first = await acquireOpenLock(f.file, { retryMs: 10, timeoutMs: 2000 })
    let secondAcquired = false
    const pending = acquireOpenLock(f.file, { retryMs: 10, timeoutMs: 2000 }).then((lock) => {
      secondAcquired = true
      return lock
    })
    await sleep(80)
    assert.equal(secondAcquired, false, "第一个 open 未结束时，第二个不得进入豆包单窗口")
    first.release()
    const second = await pending
    assert.equal(secondAcquired, true)
    second.release()
  } finally {
    f.cleanup()
  }
})

test("持有锁的进程异常退出后，后续 open 能回收锁", async () => {
  const f = fixture()
  try {
    const moduleUrl = new URL("../src/open-lock.mjs", import.meta.url).href
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireOpenLock } from ${JSON.stringify(moduleUrl)};
      await acquireOpenLock(${JSON.stringify(f.file)}, { retryMs: 10, timeoutMs: 2000 });
      process.exit(0);
    `], { stdio: ["ignore", "pipe", "pipe"] })
    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)))
    })
    assert.equal(fs.existsSync(f.file), true, "异常退出没走 finally，锁文件应留下来模拟真实现场")
    const lock = await acquireOpenLock(f.file, { retryMs: 10, timeoutMs: 2000 })
    lock.release()
  } finally {
    f.cleanup()
  }
})

test("SessionManager.open 与 convMessage 共用窗口锁：新建合并会话时巡检不得抢窗", async () => {
  const f = fixture()
  try {
    const events = []
    const merge = new SessionManager({
      book: new SessionBook(f.state),
      doubao: {
        state: async () => ({ signedIn: true, convId: "99999999" }),
        openTask: async () => {
          events.push("start:merge")
          await sleep(80)
          events.push("end:merge")
          return { convId: "38454241420961538", locatedBy: "window" }
        },
      },
    })
    const inspector = new SessionManager({
      book: new SessionBook(f.state),
      doubao: {
        goto: async () => events.push("goto:inspector"),
        message: async (_text, options) => {
          assert.equal(options.expectedConvId, "38454817176894466")
          events.push("send:inspector")
        },
      },
    })
    const first = merge.open("merge", { prompt: "merge", noWait: true })
    while (!events.length) await sleep(5)
    const second = inspector.convMessage("38454817176894466", "飞行检查", { mode: "queue" })
    await sleep(30)
    assert.deepEqual(events, ["start:merge"], "合并会话新建未完成时，巡检不得切入并发送")
    await Promise.all([first, second])
    assert.deepEqual(events, ["start:merge", "end:merge", "goto:inspector", "send:inspector"])
  } finally {
    f.cleanup()
  }
})

test("SessionManager.open：并发新建不串线，等待后的账本也不会覆盖前一条记录", async () => {
  const f = fixture()
  try {
    const events = []
    const client = (id, label) => ({
      state: async () => ({ signedIn: true, convId: "99999999" }),
      openTask: async () => {
        events.push(`start:${label}`)
        await sleep(80)
        events.push(`end:${label}`)
        return { convId: id, locatedBy: "window" }
      },
    })
    // 两个 manager 在第一个写账前就构造，模拟两个独立 dws 进程都拿到旧账本。
    const merge = new SessionManager({ book: new SessionBook(f.state), doubao: client("10000001", "merge") })
    const worker = new SessionManager({ book: new SessionBook(f.state), doubao: client("10000002", "worker") })
    const first = merge.open("merge", { prompt: "merge", noWait: true })
    while (!events.length) await sleep(5)
    const second = worker.open("worker", { prompt: "worker", noWait: true })
    await sleep(30)
    assert.deepEqual(events, ["start:merge"], "第二个 open 不得在前一个窗口操作未结束时进入")
    await Promise.all([first, second])
    assert.deepEqual(events, ["start:merge", "end:merge", "start:worker", "end:worker"])
    const saved = new SessionBook(f.state)
    assert.equal(saved.session("merge").convId, "10000001")
    assert.equal(saved.session("worker").convId, "10000002")
  } finally {
    f.cleanup()
  }
})
