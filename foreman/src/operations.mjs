// 操作日志：服务里的长动作先落一条 running，结束再补 success/failed。
// 存储失败不能影响派单、合并等主流程，所以这里所有异常都降级为 service.log。
export function startOperation(ctx, action, title, { key = "", detail = "" } = {}) {
  try {
    const id = ctx?.consoleStore?.operationStart?.({ action, title, key, detail }) ?? 0
    ctx?.log?.(`[操作] 正在${title}${detail ? `：${detail}` : ""}`)
    return Number(id) || 0
  } catch (e) {
    ctx?.log?.(`操作日志写入失败（${action}）：${e.message}`)
    return 0
  }
}

export function finishOperation(ctx, id, status = "success", detail = "") {
  if (!id) return
  try {
    ctx?.consoleStore?.operationFinish?.(id, status, detail)
    const title = ctx?.consoleStore?.operationGet?.(id)?.title || "操作"
    ctx?.log?.(`[操作] ${title}${status === "success" ? "完成" : status === "interrupted" ? "中断" : "失败"}${detail ? `：${detail}` : ""}`)
  } catch (e) {
    ctx?.log?.(`操作日志收尾失败：${e.message}`)
  }
}
