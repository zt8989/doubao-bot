# 通用 workflow：两条生命周期 + 节点 + 适配器

foreman 的流程不再写死「豆包 + Gitea + herdr」，也不再是一条大链路。现在分**两条生命周期**：

| 流程 | id | 谁的单 | 阶段 |
|---|---|---|---|
| 自有工单 | `own` | 作者是自己（或无人认领） | 接单 → 建工作区 → 派活 → 开发 → 出 PR → 合并 → 关单 → 清理 → 归档 → 通知 |
| 他人 PR | `review` | PR 是别人开的 | 扫到 → 核对 → 合并 → 关单 → 清理 → 归档 → 通知 |

两条流程**后半段共用**（merge / close / cleanup / archive / notify），前半段完全不同：`own` 从一张工单开始，
`review` 从一条 PR 开始，不接单、不建 worktree。共用阶段靠 `payload.workflow` 标明属于哪条流程。

代码分四层：

```
service.mjs                  常驻服务、定时器、RPC；只在关键节点发事件
  └─ workflow/engine.mjs     流程级动作（afterMerge 收尾流水线、节点表、在跑实例）
      ├─ workflow/lifecycle.mjs   两条流程的阶段表 + 事件总线 + 流程实例 + 钩子 + 历史
      ├─ workflow/nodes.mjs       节点暂停/继续 + 累计执行次数（落 state.json）
      └─ workflow/adapters/       每个外部工具一个适配器
          ├─ doubao.mjs           会话（豆包 / dws）
          ├─ gitea.mjs            工单与 PR（Gitea / opencli）
          ├─ herdr.mjs            工作区（herdr + git worktree）
          └─ session.mjs          SessionAdapter 契约（ assertSessionAdapter ）
```

## 阶段与事件

| 阶段 | 事件 | 自动节点 | 含义 |
|---|---|---|---|
| pickup | `issue.picked` | 是 | 捞到一张可接的工单（作者是自己，或无人认领） |
| workspace | `workspace.ready` | 是 | worktree / 工作区就绪 |
| dispatch | `session.dispatched` | 是 | 执行会话已派出（首句送达） |
| develop | `session.finished` | 否 | 开发会话跑完，拿到结论 |
| conclude | `issue.concluded` | 是 | 工单结论落账（done/failed/…） |
| pr-open | `pr.opened` | 否 | 会话自测通过并 push，PR 已开 |
| scan | `pr.scanned` | 是 | 扫到一条别人的 open PR |
| review | `pr.reviewed` | 否 | 核对过关联工单与改动，定下合不合 |
| merge | `pr.merged` | 是 | PR 已合并 |
| close | `issue.closed` | 是 | 关联工单已关闭（关单） |
| cleanup | `workspace.cleaned` | 是 | herdr 工作区与 worktree 已清理 |
| archive | `session.archived` | 是 | 会话已归档收起 |
| notify | `notice.delivered` | 是 | 结论节点（只落痕，暂不发消息） |

`Lifecycle.emit(event, payload)` 的顺序：**先跑 `hooks[event]`，再按注册顺序跑每个适配器的 `on(event, payload)`**。
适配器善后失败只写日志，不打断主流程（合并成功不会因为归档失败被推翻）。
最近 200 条事件留在 `lifecycle.history`，`foreman status` 的 `workflow.recent` 能看到最后 12 条。

## 流程实例（在跑几条）

`Lifecycle.runs` 记每条流程的实例：`workflow + 工单号/PR 号` 唯一，跟着事件推进阶段，
走到 `close` 就算收口（退出「在跑」计数，后面的清理/归档不再占名额）。

- `engine.active("own")` → 在跑的自有工单流程；**自动接单的容量就按它算：同时最多 2 条**（`pickup.maxRunning`）。
- 服务重启后 `engine.restore(book)` 用账本里 `planned / working / pr-open` 的工单把实例补回来，
  否则容量会被算成 0，又去重复派同一张单。

## 节点：暂停 / 继续 / 统计

节点就是上面表里的一个阶段。首页「分配任务」里每条工单展开能看到自己那条流程的节点，
workflow 面板能看到两条流程的全部节点。

- **暂停是节点级的**：只停这个节点自己的自动动作，**不停止整条 workflow**——在跑的单照常推进，
  后面的节点也照跑。`pickup` 暂停就不自动接单；`scan` 暂停就不扫别人的 PR；`notify` 暂停就不发结论通知；
  `cleanup` 暂停就跳过本地清理（只写 notes）。
- **统计是累计的**：自动节点每执行一次 +1，只增不减（暂停、重启、换天都不归零）。
- 状态落在 `state.json` 的 `workflow` 键：`{ paused: ["pickup"], counts: { pickup: { count, lastAt, firstAt, detail } } }`。
- 接口：`foreman workflow view|pause|resume <节点>`（RPC），控制台走 `GET/POST /api/workflow`。

## 合并：合并助手只判断，workflow 落地

合并不再有独立通道、独立定时任务、独立并发槽。合不合由**合并助手会话**判断：

1. `prWatch` 扫到别人的 open PR → 投递一条合并会话（`sessions.notice = "PR待合并"`）；
2. 合并助手核对归属/基线，有冲突就在隔离工作区解掉并普通 push，然后交一个 RESULT
   （`status` / `mergeable` / `conflict` / `repo` / `pr` / `prUrl`）；
3. 服务的 `mergeVerdictOnce`（每轮 `pollOnce` 末尾，复用同一次侧边栏读取）消费这份结论：
   - `mergeable=true` → 走 `runMergeTask`（与 CLI `foreman pr merge` 共用 `ctx.mergeChain`）合并 + 收尾流水线；
   - `need_decision` / `blocked` / merge 失败 → 记 `mergeJudge`，写控制台 `pr_judge` 事件，交给人；
   - 判过就不再读这条会话（读 `dws info` 要切用户窗口）；`merge.verdictAutoMerge: false` 时只判断不合。
4. 合并结果只落账本与控制台（`mergeAsk` / `mergeTask` / `pr_merge`），**不回执、不通知任何人**：
   关单 / 清工作区 / 归档做完就收工，合并助手交完 RESULT 也停手；合失败同样只记账，原因看 `mergeAsk.error`。
5. **合并要指出工程与 worktree**：日志 / 控制台事件 / CLI 回包都写 `工程 <仓库> · worktree <路径>`，
   worktree 取账本里这条单的实现工作区（一工程一工作区时按 PR 所在仓库对号）；别人的 PR 没有工作区时写
   「无 worktree」并留一行说明，清理 notes 也带路径（`worktree 已删除：<路径>`）。

会话跑完仍会把「PR 已开好」记进账本（notify 节点只落痕、不发消息），真正落地合并的是 workflow，不是会话自己。

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
- 工单收口（`done`/`cleaned`）后归档**这张单自己的编排会话**：`clean` 里收一次，服务每轮巡检
  再兜一次底（只认账本里 `kind: "orchestrator"` 且带该单 `issueKey` 的会话，全局编排与用户自己的会话不动；还在跑的先跳过）；
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
  "pickup": { "maxRunning": 2 },
  "workflow": {
    "archiveAfterMerge": true
  }
}
```

`maxRunning` 现在按「在跑的自有工单流程」算，不再数零散的 watcher。
`archiveAfterMerge` 默认 `true`：PR 合并并清理后，执行会话自动 `dws archive`（留 markdown 存档，不是删除）。
