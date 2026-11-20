// cron 统一出口：实际解析交给 croner（零依赖、ESM），这里只包一层项目里要的返回形状。
// 支持标准 5 段「分 时 日 月 周」以及 6 段带秒；非法表达式在保存前会被 validateCron 拦下。
import { Cron } from "croner"

/** 解析并校验；非法时抛带说明的 Error。 */
export function parseCron(expression) {
  const text = String(expression ?? "").trim().replace(/\s+/g, " ")
  if (!text) throw new Error("cron 表达式为空")
  // paused:true 只算时间，不真的起定时器；定时由 service 自己排，方便页面上改完就重排。
  const job = new Cron(text, { paused: true })
  return { expression: text, job }
}

export function validateCron(expression) {
  try {
    const parsed = parseCron(expression)
    return { ok: true, expression: parsed.expression }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 下一次触发时刻（严格晚于 from）。 */
export function nextCronTime(expression, from = new Date()) {
  const { job } = typeof expression === "string" ? parseCron(expression) : expression
  return job.nextRun(from) ?? null
}

/** 给人看的一行说明（页面开关旁边显示用）。 */
export function describeCron(expression) {
  const v = validateCron(expression)
  if (!v.ok) return v.error
  const every = /^(\*\/\d+) \* \* \* \*$/.exec(v.expression)
  if (every) return `每 ${every[1].slice(2)} 分钟`
  if (v.expression === "* * * * *") return "每分钟"
  const next = nextCronTime(v.expression)
  return next
    ? `下次 ${next.getMonth() + 1}月${next.getDate()}日 ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`
    : "没有可触发的时间"
}
