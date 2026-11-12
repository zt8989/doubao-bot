# 通用 workflow：生命周期 + 适配器

foreman 的流程不再写死「豆包 + Gitea + herdr」。代码分三层：

```
service.mjs                 常驻服务、定时器、RPC；只在关键节点发事件
  └─ workflow/engine.mjs    流程级动作（目前：afterMerge 收尾流水线）
      └─ workflow/lifecycle.mjs   阶段表 + 事件总线 + 钩子 + 历史
          └─ workflow/adapters/   每个外部工具一个适配器
              ├─ doubao.mjs       会话（豆包 / dws）
              ├─ gitea.mjs        工单与 PR（Gitea / opencli）
              ├─ herdr.mjs        工作区（herdr + git worktree）
              └─ session.mjs      SessionAdapter 契约（ assertSessionAdapter ）
```

## 生命周期

| 阶段 | 事件 | 含义 |
|---|---|---|
| pickup | `issue.picked` | 捞到一张可接的工单 |
| workspace | `workspace.ready` | worktree 就绪 |
| dispatch | `session.dispatched` | 执行会话派出 |
| watch | `session.finished` | 执行会话跑完 |
| conclude | `issue.concluded` | 工单结论落账 |
| merge | `pr.merged` | PR 已合并 |
| cleanup | `workspace.cleaned` | herdr 工作区与 worktree 已清理 |
| archive | `session.archived` | 会话已归档 |
| notify | `notice.delivered` | 结论已投递给编排会话 |

`Lifecycle.emit(event, payload)` 的顺序：**先跑 `hooks[event]`，再按注册顺序跑每个适配器的 `on(event, payload)`**。
适配器善后失败只写日志，不打断主流程（合并成功不会因为归档失败被推翻）。
最近 200 条事件留在 `lifecycle.history`，`foreman status` 的 `workflow.recent` 能看到最后 12 条。

## 适配器契约

**SessionAdapter**（`adapters/session.mjs`）必需方法：

- `openExecution({name, repo, prompt})` / `resumeExecution({name, prompt})`
- `deliver({name, prompt, noWait})`（开通知/编排会话）
- `status(target)` / `info(target)` / `notify(target, text)`

可选：`runningMap()`、`archive(target)`、`on(event, payload)`；能力标记 `capabilities.singleInstance`。

**DoubaoSessionAdapter** 把豆包的特殊性全部收在一处：

- 单实例窗口：`busyWatchers(ids)` 用侧边栏判断哪些被监听会话还在跑（window-busy 护栏）；
- 读状态会切窗口：优先 `runningMap()`，只有没在跑的才逐条 `status`；
- `pr.merged` 时归档执行会话（`workflow.archiveAfterMerge: false` 可关，默认开）；
- 保留旧调用面 `open/send/openNew`，所以 orchestrator 与既有测试不需要改。

**GiteaTrackerAdapter**：`listIssues/listPulls/mergePr/closeIssue/createPr/commentIssue`。
**HerdrWorkspaceAdapter**：`create()`、`cleanup()`；`herdr.enabled: false` 时退回纯 git worktree。

## 接一个新载体

以「飞书会话」为例：写一个 `FeishuSessionAdapter`，实现上面的必需方法（`runningMap` 可不实现，
流程会退回逐条 `status`），在 `startServer` 替换 `session` 即可；流程、账本、合并与清理逻辑不变。
tracker / workspace 同理。

## 配置

```json
{
  "workflow": {
    "archiveAfterMerge": true
  }
}
```

`archiveAfterMerge` 默认 `true`：PR 合并并清理后，执行会话自动 `dws archive`（留 markdown 存档，不是删除）。
