// Gitea 工单/PR 适配器：workflow 只通过它读写工单与 PR。
// 换 Jira / GitLab 时照这个形状再写一个即可。
import { listPulls, listIssues, viewIssue, viewPr, mergePr, closeIssue, createPr, commentIssue, editLabels, createIssue, editIssue } from "../../gitea.mjs"

export class GiteaTrackerAdapter {
  constructor({ impl = {} } = {}) {
    this.impl = { listPulls, listIssues, viewIssue, viewPr, mergePr, closeIssue, createPr, commentIssue, editLabels, createIssue, editIssue, ...impl }
    // 能力位：issueRef = 工单有「右侧分支」字段（Gitea 有；GitHub/Jira 没有，实现时别硬造）。
    this.capabilities = { issueRef: true }
  }

  viewIssue(repo, number) {
    return this.impl.viewIssue(repo, number)
  }

  viewPr(repo, number) {
    return this.impl.viewPr(repo, number)
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

  // 建单（一条龙的起点）与改单字段（Issue.ref 等）。缺省实现透传；换 tracker 时按需实现，
  // 服务端对 editIssue 一律先看能力位再调，GitHub 类没有 ref 字段的实现不会被打到。
  createIssue(repo, args) {
    return this.impl.createIssue(repo, args)
  }

  editIssue(repo, number, patch) {
    return this.impl.editIssue(repo, number, patch)
  }

  // 关单时摘接单标签：标签是 close 节点的产物，由它自己收。
  editLabels(repo, number, opts) {
    return this.impl.editLabels(repo, number, opts)
  }

  async on() {
    // Gitea 侧没有生命周期善后：关单由流程显式调用 closeIssue。
  }
}
