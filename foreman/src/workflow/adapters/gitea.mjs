// Gitea 工单/PR 适配器：workflow 只通过它读写工单与 PR。
// 换 Jira / GitLab 时照这个形状再写一个即可。
import { listPulls, listIssues, mergePr, closeIssue, createPr, commentIssue } from "../../gitea.mjs"

export class GiteaTrackerAdapter {
  constructor({ impl = {} } = {}) {
    this.impl = { listPulls, listIssues, mergePr, closeIssue, createPr, commentIssue, ...impl }
  }

  listIssues(repo, opts) {
    return this.impl.listIssues(repo, opts)
  }

  listPulls(repo, opts) {
    return this.impl.listPulls(repo, opts)
  }

  mergePr(repo, pr, opts) {
    return this.impl.mergePr(repo, pr, opts)
  }

  closeIssue(repo, number) {
    return this.impl.closeIssue(repo, number)
  }

  createPr(args) {
    return this.impl.createPr(args)
  }

  commentIssue(repo, number, body) {
    return this.impl.commentIssue(repo, number, body)
  }

  async on() {
    // Gitea 侧没有生命周期善后：关单由流程显式调用 closeIssue。
  }
}
