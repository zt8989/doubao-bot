// Schedule 只把可处理的信息写入 Inbox；普通的“执行完成”回执不产生事件。
const object = (value) => value && typeof value === "object" && !Array.isArray(value)

export function normalizeEventEnvelope(value) {
  if (!object(value)) return null
  const type = String(value.type ?? "").trim()
  const text = typeof value.text === "string" ? value.text.trim() : ""
  const hasJson = value.json !== undefined && value.json !== null
  if (!type || (!text && !hasJson)) return null
  const json = hasJson ? value.json : {}
  try { JSON.stringify(json) } catch { return null }
  return { type, text, json }
}

function failureEnvelope(schedule, executor, error, type = "schedule.error") {
  const message = String(error || "未知错误")
  return {
    type,
    text: `${schedule.id} ${executor === "agent" ? "Agent 调用" : "脚本执行"}失败：${message}`,
    json: { scheduleId: schedule.id, executor, error: message },
  }
}

function mailEnvelope(result) {
  const keys = ["routed", "matched", "verdicts", "steered", "merged", "reminders"]
  if (!keys.some((key) => Number(result?.[key] ?? 0) > 0)) return null
  const labels = { routed: "普通回复", matched: "验收回复", verdicts: "验收判定", steered: "注回会话", merged: "合并", reminders: "催办" }
  const parts = keys.filter((key) => Number(result?.[key] ?? 0) > 0).map((key) => `${labels[key]} ${Number(result[key])}`)
  return {
    type: "mail.activity",
    text: `邮件轮询：${parts.join(" · ")}`,
    json: Object.fromEntries(["checked", ...keys].map((key) => [key, Number(result?.[key] ?? 0)])),
  }
}

export function scheduleEnvelope(schedule, executor, result) {
  if (result?.ok === false) return failureEnvelope(schedule, executor, result?.error)

  // 自定义脚本可返回 { ok, inbox: { type, text, json } }，也可直接返回 { ok, type, text, json }。
  // inbox: false 表示脚本明确声明本轮没有需要入箱的信息。
  const declared = result?.inbox !== undefined
    ? result.inbox
    : result?.type !== undefined ? result : null
  if (declared === false || declared === null && result?.inbox === null) return null
  if (declared) {
    const normalized = normalizeEventEnvelope(declared)
    if (normalized) return normalized
    return failureEnvelope(schedule, executor, "Inbox 事件需要 type，以及 text 或 json", "schedule.invalid_event")
  }

  // PR 候选已经由 prWatch 写成带 JSON 的 router.notice，不能再重复写一份扫描完成摘要。
  if (schedule.id === "prWatch" && result?.failedNotify) {
    return {
      type: "prWatch.notify_failed",
      text: `PR 候选通知投递失败，下轮重试；待处理 ${Number(result.pending ?? 0)} 条`,
      json: { checked: Number(result.checked ?? 0), pending: Number(result.pending ?? 0), target: String(result.target ?? "") },
    }
  }
  if (schedule.id === "prWatch" && Number(result?.pending ?? 0) > 0 && !String(result?.target ?? "").trim()) {
    return {
      type: "prWatch.notify_pending",
      text: `发现 ${Number(result.pending)} 条 PR 候选，但没有可用的通知目标`,
      json: { checked: Number(result.checked ?? 0), pending: Number(result.pending) },
    }
  }
  if (schedule.id === "mail") return mailEnvelope(result)
  return null
}

export function eventText(event) {
  const direct = String(event?.text ?? "").trim()
  const envelope = normalizeEventEnvelope(event?.payload)
  const hasJson = envelope && envelope.json !== undefined
    && !(object(envelope.json) && Object.keys(envelope.json).length === 0)
    && !(Array.isArray(envelope.json) && envelope.json.length === 0)
  const jsonText = hasJson ? JSON.stringify(envelope.json, null, 2) : ""
  if (direct && jsonText) return `${direct}\n\n${jsonText}`
  if (direct) return direct
  if (envelope?.text && jsonText) return `${envelope.text}\n\n${jsonText}`
  if (envelope?.text) return envelope.text
  if (hasJson) return jsonText
  return JSON.stringify(event?.payload ?? {})
}
