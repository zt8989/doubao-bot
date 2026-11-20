// 旧内部接口兼容层；公开角色统一为 router agent（路由智能体）。
export { inspectionSnapshot, routerOnce } from "./core/router.mjs"
import { routerOnce } from "./core/router.mjs"

export function inspectorOnce(ctx, options = {}) {
  return routerOnce(ctx, options)
}
