// herdr 工作区适配器：建 worktree、合并后清理（关 herdr 工作区 + 删 worktree + 安全删分支）。
// 没有 herdr 的环境：useHerdr=false 时退回纯 git worktree。
import { createWorktree, cleanupMergedWorktree } from "../../gitx.mjs"

export class HerdrWorkspaceAdapter {
  constructor({ cfg = {}, log = () => {} } = {}) {
    this.cfg = cfg
    this.log = log
  }

  create({ repoDir, worktreeDir, branch, base }) {
    return createWorktree({
      repoDir,
      worktreeDir,
      branch,
      base,
      herdrBin: this.cfg.herdr?.bin ?? "herdr",
      useHerdr: this.cfg.herdr?.enabled !== false,
      log: this.log,
    })
  }

  cleanup({ repoDir, worktree, branch }) {
    return cleanupMergedWorktree({
      repoDir,
      worktree,
      branch,
      herdrBin: this.cfg.herdr?.bin ?? "herdr",
      useHerdr: this.cfg.herdr?.enabled !== false,
      log: this.log,
    })
  }

  async on() {
    // 清理由 engine 在 pr.merged 流程里显式调用，避免重复执行。
  }
}
