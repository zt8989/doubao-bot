// 通道（lane）：一条独立队列 + 一个并发上限。
// 派单与合并各走各的通道：合并卡在 opencli 的 20–40s 里时，派单照样能进；
// 两条通道不共用锁，也不互相排队。
export class Lane {
  constructor({ name = "", limit = 1, log = () => {} } = {}) {
    this.name = name
    this.limit = Math.max(1, Math.floor(Number(limit) || 1))
    this.log = log
    this.queue = []
    this.running = new Map() // key -> promise
    this.byKey = new Map() // key -> promise（排队中或执行中，用于去重）
    this.tail = Promise.resolve() // 最近一条任务的收尾 promise，idle() 等它
    this.done = 0
    this.failed = 0
  }

  get size() {
    return this.running.size
  }

  get pending() {
    return this.queue.length
  }

  busy() {
    return this.running.size > 0
  }

  has(key) {
    return this.byKey.has(String(key))
  }

  // submit 返回这条任务的 promise；同一个 key 在跑或在排队时直接复用，不会重复执行。
  submit(key, task) {
    const k = String(key)
    const existing = this.byKey.get(k)
    if (existing) return existing
    let resolveFn
    let rejectFn
    const p = new Promise((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    this.byKey.set(k, p)
    this.tail = p.then(() => {}, () => {})
    this.queue.push({ key: k, task, resolve: resolveFn, reject: rejectFn })
    queueMicrotask(() => this.pump())
    return p
  }

  // idle：等已交上来的任务全部跑完（按提交顺序串成一条链）。调度侧「跑完这一轮」用。
  idle() {
    return this.tail
  }

  // pump 按上限把队列里的任务拉起来；任务结束再拉下一条。
  pump() {
    while (this.running.size < this.limit && this.queue.length) {
      const job = this.queue.shift()
      const p = Promise.resolve()
        .then(() => job.task())
        .then(
          (v) => {
            this.done++
            return v
          },
          (e) => {
            this.failed++
            throw e
          }
        )
      this.running.set(job.key, p)
      // 先摘 running/byKey，再 resolve 给调用方：await 拿到结果时 snapshot 里就不该再有它。
      p.then(
        (v) => {
          this.running.delete(job.key)
          this.byKey.delete(job.key)
          job.resolve(v)
          this.pump()
        },
        (e) => {
          this.running.delete(job.key)
          this.byKey.delete(job.key)
          job.reject(e)
          this.pump()
        }
      ).catch(() => {}) // 调用方没 await 时不要炸成 unhandled rejection
    }
  }

  snapshot() {
    return {
      name: this.name,
      limit: this.limit,
      running: [...this.running.keys()],
      pending: this.queue.map((j) => j.key),
      done: this.done,
      failed: this.failed,
    }
  }
}
