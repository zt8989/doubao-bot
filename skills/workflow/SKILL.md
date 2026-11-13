---
name: workflow
description: 端到端接单工作流：派活、建工作区、开会话、监听、结论落账、合并由 foreman 串起来；只有**建 PR（`foreman pr open`）、合并（`foreman pr merge`）与补开工作区（`foreman ws add`）**必须经 foreman（都要写账本）；一工程一工作区，跨工程的单每个工程各一个 worktree、各一条 PR；opencli gitea 的读与建单/改单/评论/关单、herdr、dws 会话都直连。当用户说「走一遍工作流」「整条链路」「接单到出 PR 怎么串」「结论落在哪」「几个工具怎么分工」，或问某一环卡在哪（app_busy / 会话没开起来 / 验收不过 / 卡在 pr-open）时使用。
---

# workflow：一条工单从接到收

**接单链路的编排归 foreman，但不是所有动作都要经它。** 只有两步收口：建 PR（`foreman pr open`）和合并（`foreman pr merge`）—— 账本要把 PR 挂到「单 + 会话」上，合并要幂等，绕过去控制台就断档。其余 Gitea 读写（读单读 PR、建单、评论、改标签、关单）、`dws` 会话、`herdr` 都能直接调，不必绕 foreman。

| 层 | 谁调 | 说明 |
| --- | --- | --- |
| `foreman` | 人 / agent / 会话 | 接单、派活、监听、通知、建 PR、合并、查进度、回炉 |
| `opencli gitea` | foreman 内部 + 人直连 | 工单/PR 读写；**只有建 PR、合并必须走 foreman**，其余读写直连 |
| `herdr` | foreman 内部 + 人直连 | 建 worktree；失败自动退回 `git worktree add` |
| `dws` | foreman 内部 + 人直连 | 豆包会话（开会话/续说/读状态/通知），不经 foreman 也行 |

代码在 `/Users/zhouteng/Documents/workspace/doubao-bot`（`foreman/`、`dws/`、`adapters/gitea/`），已 `npm link` 成全局命令。

## 标准一轮（六步）

1. **看计划**：`foreman run --dry-run --once`（可加 `--repo <名字|owner/name>`）。
   打印会捞哪条、worktree 建在哪、首句提示词长什么样；不建工作区、不动会话。
   接单顺序由配置决定：**我的（作者 `pickup.me`）→ 无人认领 → 他人**，同档最老先接。
2. **派活**：`foreman run --once`（常驻用 `foreman run --every 1800`）。
   foreman 内部依次做：选单（`opencli gitea search`，标签用数字 id）→ **按工程各建一个 worktree**（`herdr`，失败退回 `git worktree add`）→ `dws open --name foreman-<工单所在仓库>-<N>` 发 kickoff → 账本记 `working` + `agent` + `workspaces` → 登记监听。**派完只返回 `dispatched`，不等回复。**
   kickoff 把边界按工程写死：**一工程一工作区**，每个工程只在自己那条工作区里改；要改的工程不在清单里就先 `foreman ws add` 现开（别交 need_decision、别动主 checkout）；每个工程自测通过后各自 `git push -u origin <分支>`，各自用 `foreman pr open … --issue N --issue-repo <工单所在仓库>` 开 PR；不合并、不 force push。
3. **会话侧产出**：在每个工程自己的工作区改代码 → 各自提交 → 各自自测 → 各自 push → 各自 `foreman pr open --repo <该工程> --head <分支> --title "fix(#N): …" --body "<自证>" --issue N [--issue-repo <工单所在仓库>]`（基线取配置 `repos[].base`，不写死）。
   PR **只能**经 foreman 建（`pr open`），它写账本、立刻落 SQLite 控制台；工单侧评论/关单/改标签可以直接 `opencli gitea`，不经 foreman 也不影响流转。最后交 RESULT：`done` 用 `prs[]` 交每条 PR（一个工程一条），`tests` 写清每个工程跑了什么。
4. **收结果**：服务在后台轮询 `dws status` + `dws info`，取最后一个 `<RESULT>` 块，推进工单状态与账本。
   当前 notify 节点**只落痕、不发消息**（不新建会话、不 `dws send`、不带续接催办）；`planner` 的续接内容也不再拼进任何消息。
   看进度用 `foreman tasks`，看服务用 `foreman status`；**不要拿 `dws status` 手工判**（那是服务内部的事）。
5. **合并**：`merge.enabled: true` 时 **foreman 自己合并**（`pr-merge` + `close`），每张 PR 只合一次（账本 `mergeAsk`），`tests` 为空不自动合，冲突只记录不 force merge。
   **合完/合失败都不回执通知**：结果只落账本与控制台（`mergeAsk` / `pr_merge`），关单、清工作区、归档在 `afterMerge` 做完就收工。
   **合并要指明工程与 worktree**：日志/控制台/回包写 `工程 <仓库> · worktree <路径>`，没有工作区就写「无 worktree」，清理 notes 也带路径。
   要人工决定就 `enabled: false`（默认），PR 停在 `pr-open` 等人。
6. **回炉与收尾**：卡住的单先 `foreman tasks` 看状态，再 `foreman retry <仓库名|owner/name> <N>` 放回队列（attempts 清零）；worktree 需要清理时按 `~/.foreman/worktrees/<工程>/fix-issue-N` 手动 `git worktree remove`（这是唯一需要动 git 的收尾动作；跨工程的单有好几个目录，按工程逐个清）。

## 一工程一工作区（跨工程工单）

一张单要求同时改两个仓库（比如 `win-ai-harness/web` 与 `yyjz-oa-frontend/apps/admin` 的镜像页）时，**不是一张单一个 worktree，而是一个工程一个 worktree、一个工程一条 PR**：

- 派单时主仓库（工单所在仓库）永远有工作区，其余工程从工单标题+正文里的 `owner/name`、`<仓库名>/<子路径>` 或仓库名认出来（只在本产品内认），各建一个。
- 首句把每个工程的工作区列成清单，并写死「不在这张清单里的工程，先 `foreman ws add --repo <工程> --issue <owner/name>#N` 现开一个（幂等），再进去改」。**执行会话不该因为跨工程交 need_decision。**
- 每个工程各自提交、各自 push、各自 `foreman pr open --repo <该工程> … --issue N --issue-repo <工单所在仓库>`；账本把几条 PR 记成同一张单的 `prs[]`。
- 合并按工程逐条来：合一条只清那个工程的工作区；**所有工程的 PR 都合完才关单**。RESULT 里 `prs` 多于一条时不自动合（`multi-pr`），交编排核对后逐条 `foreman pr merge`。
- 现场补开/查看：`foreman ws add --repo <工程> --issue <owner/name>#<N>`、`foreman ws list --issue <owner/name>#<N>`。

## 通知（notify 节点保留，当前只落痕）

`foreman run` 派完就返回，不发通知。会话跑完后由服务判定并发；判定照做、指纹照记，notify 节点落一次痕，**但不向谁发消息**：

```json
"notify": {
  "enabled": true,
  "session": "auto",
  "events": ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"]
}
```

- **notify 节点保留，但暂时只落痕、不投递**：会话跑完照常判结论、推进工单状态（`done`→`pr-open`/`done`，`need_decision`→`needs-human`，`blocked`/`failed` 各自停态）、记指纹去重，节点落一次 `notice.delivered` 痕；**不新建派单会话、不 `dws notify`、也不带续接催办**。`deliver.mode` 与 `notify.enabled` 暂时不影响「发不发」——要恢复投递看 git 历史里 2026-11-13 之前的 `pollOnce`。
- `deliver.mode: "new"` 仍用于 **PR 扫描**：扫到别人的 PR 时**新建一条合并会话**，首句 = 合并提示词（默认代码内置的 `src/builtin/merge-prompt.md`）+ `监控项目：<deliver.projectDir>` + PR 列表；新会话 `notify: false`，不进监听。
- `deliver.mode: "existing"` 才塞回已有会话：`session` 写 `auto` → 取 `MCP_VM_CONVERSATION_ID`；也可写会话 id 或侧边栏标题。
- 命令行：`foreman run --notify <会话id|标题>` 只改这一轮登记的通知目标；`--no-notify` = 这一轮不登记监听。
- **合并不回执**：`foreman pr merge` 或合并助手判 `mergeable=true` 落地合并后，只落账本（`mergeAsk` / `mergeTask`）+ 控制台 `pr_merge`，关单 / 清 herdr 工作区 / 删 worktree 与本地分支 / 归档执行会话都在 `afterMerge` 做完；合失败也只记账（看 `mergeAsk.error`）。

## PR 监听（服务里 5 分钟一轮）

服务另有定时器：每 `prWatch.intervalSeconds`（默认 300s）扫各仓库 open PR，**作者不是自己的（`pickup.me`）** 的单先过一遍冲突（有冲突的默认不报，`filterConflicts`），剩下的**交给编排 agent**：`deliver.mode: "new"`（默认）**每次新建一条会话**，首句是编排提示词（默认用代码内置的那份）+ 监控项目 + PR 列表；`deliver.mode: "existing"` 才塞回 `prWatch.notifyTarget`（默认 `earliest`，最早登记的调用方会话）。通知里带 `foreman pr merge <N> --repo R`；合并由编排 agent 核对工单后执行，合不了 foreman 回理由。命令：

```bash
foreman pr poll   # 立刻扫一轮（checked / notified / target）
foreman pr list   # 看 PR 监听账本
```

## 铁律

- **只有两步必须经 foreman**：建 PR `foreman pr open`、合并 `foreman pr merge`。其余随便：读单读 PR `opencli gitea pr-view|issue-view|search`、建单/评论/改单/关单 `opencli gitea issue|issue-comment|issue-edit|close`、`herdr`、`dws` 都直连。**一工程一工作区**的补开工作区 `foreman ws add` 例外——它要写账本，也得经 foreman。
- **基线与状态这类 foreman 自己的动作照旧走它**：接单 `foreman run`、看进度 `foreman tasks`、回炉 `foreman retry`、服务 `foreman ping|status|serve`。
- **基线由配置 `repos[].base` 决定**（本工程当前 `sit-20261126`），不用 `dev`；`foreman pr open` 不写 `--base` 就取它。
- **不 force merge**：冲突就停下、留记录、交人。
- **会话自测通过就 push，再用 `foreman pr open` 开 PR，不合并**；`merge.enabled: true` 时由 foreman 合并。
- **建 PR 必须走 foreman**；直接 `opencli gitea pr` 开的 PR 在账本里不存在，控制台统计断档。工单侧怎么写都不影响账本。
- 一个工单一个会话名 `foreman-<工单所在仓库>-<单号>`，同名续会话、不会重开；跨工程时名字仍按工单所在仓库起。
- **一工程一工作区、一工程一 PR**：不许把两个工程的改动塞进一个 worktree/一条 PR，也不许为了跨工程交 need_decision。
- 改仓库文件只 `git add` 自己那几个文件，别 `git add -A`。

## 常见卡点

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `app_busy` /「豆包正在用你自己的 profile 运行」 | 用户自己开着豆包，占了单实例 | 让用户 ⌘Q 退出，别换 profile、别重试 |
| 一条也捞不到 | `labelIds` 不是数字 id、被排除标签命中、或已处理过 | `foreman run --dry-run --once` 看「open N 条，可接 M 条」；`foreman tasks` 看状态 |
| 卡在 `pr-open` | `merge.enabled=false`；或一工程一工作区：还有别的工程的 PR 没合 | 正常，等人验收；跨工程时 `foreman ws list --issue <单号>` 看还差哪条，逐条 `foreman pr merge <N> --repo <该工程>` |
| 跨工程单交 `need_decision`「要改另一个仓库」 | 首句只建了一个 worktree（老行为），或工程没认出来 | `foreman ws add --repo <工程> --issue <单号>` 补开工作区，再 `foreman retry` 放回；账本 `workspaces` 里能看到几条 |
| 会话跑完没收到消息 | 通知停用期间本来就不发（notify 节点只落痕）；或服务没跑、登记被 `--no-notify` 跳过 | `foreman ping` → `foreman serve` → `foreman watch list` → `foreman watch poll` 补判一轮；结论看 `foreman tasks` |
| 合并失败 | 分支冲突 / 无可合并 | 记录在 `mergeAsk`（`failed`），不重试；按提示人工处理或 `foreman retry` |
| `skipped: locked` | 另一轮还在跑 | `~/.foreman/run.lock` 里的 pid 探活；进程死了下轮自动接管 |
| worktree 已存在 / `already checked out` | 上次没清干净 | `git worktree list` 确认不是在跑的工单，再 `remove` + `branch -D` |
| opencli 返回 401 | Chrome 登录态过期 | 让用户在 Chrome 登 Gitea，别循环重跑 |

## 状态在哪

- `~/.foreman/state.json`：工单状态机（`planned`/`working`/`done`/`pr-open`/`needs-human`/`blocked`/`escalated`/`failed`）、`sessions`、`watch`、`notified`、`prWatch`、`mergeAsk`；一工程一工作区时 `issues[].workspaces`（每个工程一条工作区）与 `issues[].prs`（每个工程一条 PR）
- `~/.foreman/console.db`：SQLite 控制台（`tasks` 带 `agent`、`prs`、`polls`），唯一键 `<owner>/<repo>#<number>`
- `~/.foreman/{service.port, foreman.pid, service.log, run.log, worktrees/}`

## 边界

foreman 管的是**接单链路的编排**：选单、派活、监听、通知、建 PR、合并、`tasks`/`retry`。它内部才碰 opencli gitea / herdr / dws；这些下层工具反过来也不该承接编排逻辑。

但**收口只到两条**：建 PR、合并。其余都直连——读单读 PR、建单、评论、改标签、关单、`herdr` 建 worktree、`dws` 开会话续话，都不必绕 foreman，也不会让工作流停住。唯一代价是：不做收口的动作不会在 `~/.foreman/console.db` 留痕。
