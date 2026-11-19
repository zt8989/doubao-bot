// 旧内部接口兼容层；公开角色统一为 router agent（路由智能体）。
export { inspectionSnapshot, routerOnce } from "./router.mjs"
import { routerOnce } from "./router.mjs"

export function inspectorOnce(ctx, options = {}) {
  return routerOnce(ctx, options)
}
