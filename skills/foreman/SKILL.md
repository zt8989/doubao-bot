---
name: foreman
description: 接单编排 CLI（项目 foreman，命令 foreman）：**以工单绑定的编排会话为中心**——自动巡检每个工单各起一条编排智能体会话，捞到工单用 `foreman hand` steer 给它；它再调 `foreman dispatch` 分配工作（建一工程一工作区 + 开工作会话，会话 id 绑回本单编排）。PR 扫描独立新建合并会话并附 PR 链接。**工作会话不认识 foreman**：它只读工单、改工作区、跑测试、**commit 就结束**（不 push、不开 PR、不碰工单）；push 分支、开 PR、合并、关单、建/清 worktree 全由 foreman 做。工作会话的更新由服务 `dws msg --mode steer` 插回本单编排会话，失败用 `foreman resume` 在同一条工作会话里续跑（绝不新开）；合并走 `foreman pr merge`（合并即关单），合完 `foreman clean` 清 worktree 与会话。只收口这几件事：**开 PR（工作会话 commit 后服务自动 push + 建 PR）、合并（`foreman pr merge`）、关单、建与清 worktree（`foreman ws add` / `foreman clean`）**。Gitea 的读、建单/改单/评论/关单、dws 会话、herdr 一律直连。**全链路异步**：`hand`/`dispatch`/`resume` 是投递动作，发出去就返回（秒级），工作会话常跑 30–60 分钟（实测 50 分钟）才 commit 收工，结论由常驻服务轮询后 `steer` 回来——**派完就走，别等回复、别轮询会话、别重派**。当用户说自动接单、接工单、把工单派给豆包、看某条工单处理到哪、把卡住的单放回队列，或提到 foreman 时报 app_busy / locked / pr-open 时使用。**一工程一工作区**：跨工程的工单每个工程各建一个 worktree、各一条 PR，缺工程用 `foreman ws add` 现开。
---

# foreman：接单编排

一个独立 CLI，源码在 `/Users/zhouteng/Documents/workspace/doubao-bot/foreman`（`doubao-bot` 工程里的子包），已 `npm link` 成全局 `foreman`。改源码立即生效。

它不实现任何下层能力，只做串联：

| 依赖 | 负责 | 谁的前提 |
| --- | --- | --- |
| `opencli gitea` | 工单/PR 读写（复用 Chrome 登录态） | Chrome 里已登录 Gitea；每条命令 20–40s |
| `herdr` | 建 git worktree（顺带在 herdr 里挂工作区） | `herdr` server 在跑（`herdr status`） |
| `dws` | 豆包会话（开会话/续说/读状态/读对话） | 豆包**单实例**，用户自己开着时要先 ⌘Q |

## 异步：发出去就返回，别等它跑完

`foreman hand` / `foreman dispatch` / `foreman resume` 都是**投递动作**：把活发进会话就返回（`handed` / `dispatched`），**不等回复、不等结论、不验收**。真正干活的是那条工作会话——一张单从 kickoff 到 commit 收工、交出 `<RESULT>`，**常要 30–60 分钟**（实测有跑到 **50 分钟**才收工的），跨工程、跑全量单测更久。**这不是卡住，是正常耗时。**

派完之后到结论回来这段，调用方不需要守着：`foreman tasks` / `foreman orch show` 瞄一眼进度，然后去干别的。

| 别做 | 为什么 |
| --- | --- |
| 守着 `dws status` / 反复读这条会话 | 豆包单实例，切窗口会挤掉服务轮询；盯得再紧结论也不会早点出来 |
| 重复 `dispatch` / 再开一条会话 | 一条单只绑一条工作会话（`agentConvId`），重派被账本 `working` 挡掉，或把一单拆成两条 |
| 自己再跑一遍验收 / 单测「确认一下」 | 结论以会话自交的 `<RESULT>` 与自证为准，重验只会把一轮拖成两轮 |

结论只有一条路回来：常驻服务按 `pollSeconds`（默认 20s）轮询，`finished` + 回复指纹变化才算收工，`done` 时 foreman 自己 push 分支 + 开 PR，再 `dws msg --mode steer` 插回**这张单绑的编排会话**（用户自主发起的就插回发起方会话）。**等待不在调用方身上**——派完即返回，服务异步判、异步落账、异步插回。

例外只有两种：服务没在跑（见「排障」最后几行，`watch poll` 补一轮）；用户明确要你现在就盯着这条单，那也别阻塞轮询，按 `pollSeconds` 节奏 `foreman watch poll`。

## 以编排会话为中心（默认）

**谁发起，谁就是这张单的编排会话**，工作会话绑到它（账本 `issues[键].orchestrator` + `agentConvId`）。两种发起：

| 发起方式 | 编排会话是谁 | 怎么派 |
| --- | --- | --- |
| 定时任务自动接单 | 这张单自己的独立编排会话（首次 hand 自动新建，按工单幂等） | 服务 `foreman hand` 交给它 → 它调 `dispatch` |
| 用户自主发起 | **发起方自己的那条会话**（`--orchestrator`，不传取 `MCP_VM_CONVERSATION_ID`） | 发起方自己调 `foreman dispatch` |

整条链路：

| 步 | 命令 | 谁做 |
| --- | --- | --- |
| 起编排会话 | `foreman orch start` | 手工兼容入口；自动巡检不要调用，hand 会按工单自动新建 |
| 交工单 | `foreman hand <owner/name>#N` | 把工单正文 steer 进编排会话，账本记 `handed`；不建工作区 |
| 分配工作 | `foreman dispatch <owner/name>#N --prompt "<编排指令>"` | **编排调用，提示词必填**：建一工程一工作区 + 开工作会话，会话 id 绑回编排；`--prompt` 注入工单分析、任务范围、依赖与验收要求，直接随派单首句进入（长指令用 `--file <路径>`），头部自动带完整工单 ID 与 URL；留空拒绝派单。已派过就 steer 同一条续跑，注入内容也合进这条消息 |
| 看链路 | `foreman orch show` | 每条编排会话（含发起方会话）绑了哪些工作会话、最近 steer 了什么 |
| 收工后开 PR | 服务自动 | 工作会话 commit 后，foreman 自己 push 分支 + 建 PR，PR 号/链接进账本并 steer 进编排（工作会话不碰这些） |
| 失败续跑 | `foreman resume <执行会话id>` | 在**指定工作会话**里 `dws msg --mode steer`，**不新开、不传工单号** |
| 合并 | `foreman pr merge <N> --repo R` | 合并即关单；结果 steer 回这条单的编排会话 |
| 清尾 | `foreman clean <owner/name>#N`（或 `--all`） | 清 worktree、本地分支、工作会话、监听与这张单的编排会话（幂等；编排会话在正跑时留给服务下一轮收） |

- 上表里 `hand` / `dispatch` / `resume` **全是异步投递**：命令返回（`handed` / `dispatched`）就等于这一步做完了，别接着等；从投递到 `<RESULT>` 回来常 30–60 分钟（见上面「异步」节）。
- 工作会话的**任何状态更新**（结论、PR、失败原因）都由服务轮询后 `dws msg --mode steer` 插进**这张单绑的编排会话**，
  不再新建会话、不再 `dws notify`；用户自主发起的单就插回发起方会话。
- 失败/卡住先由编排归因：原会话能修正才 `resume <执行会话id>`；需要其他智能体就新派并 `watch add` 登记，完成后 steer 回等待结果的原会话；不要一律续跑，也不要为同一职责重复开会话。
- PR 监听（别人家的 PR）按 `deliver.mode=new` 新建合并会话，消息里带 PR 链接，不再 steer 到全局或某张工单的编排会话。
- 降级：配置 `sessionFlow.enabled: false` 或 `foreman run --direct` 退回老的多会话模型。

## 收口边界（PR 两步 + 清尾 + 工作区）

**必须经 foreman**——因为它们要给账本写东西，绕过就是断档：

| 动作 | 命令 | 为什么非它不可 |
| --- | --- | --- |
| 建 PR | 服务自动（工作会话 commit 后） | 工作会话只 commit、不知道 foreman；push 分支与开 PR 由 foreman 做，PR 与「哪条单、哪个工程」的对应只有它知道。`foreman pr open` 仍可用（手工补开一条），但常规流程不需要人调 |
| 合并 PR | `foreman pr merge` | 每张 PR 只合一次的幂等（`mergeAsk`）+ 合完一次收干净：工单 `done`、关单、摘执行会话监听、删 worktree 与本地分支；PR 已合（回 `EMPTY_RESULT`「无需重复合并」）也按已合并收尾，不当失败；日志/控制台/回包都写明 `工程 <仓库> · worktree <路径>`（没有工作区写「无 worktree」） |
| 补开工作区 | `foreman ws add` | 一工程一工作区：执行会话要改表外的工程，就现开一个工作区（幂等、记账本 `workspaces`），收尾才清得掉 |

**其余一律直连，不经 foreman**：

- Gitea 的**读**：`pr-view` / `issue-view` / `search` / `pull-list` / `label-list` / `milestone` / `explore`。
- Gitea 的**其它写**：`issue`（建单）、`issue-comment`、`issue-edit`（标题/正文/标签/指派）、`close` / `reopen`、`assign` / `due` / `milestone-set`。
- `dws` 全部会话类命令（`open` / `send` / `status` / `info` / `list` / `use` / `steer` / `stop` / `archive` / `notify`）。
- `herdr` 全部。

理由：读不产生状态、改了也不推进状态机，这些下一轮 `search --label` / `pull-list` 自然读到最新值，没有东西依赖它们实时进账本。`foreman issue comment|close` 还在、用了会顺手落库，但**不是必须**。

## 一工程一工作区（跨工程工单）

**原则：一个工程一个工作区，一个工程一条 PR。** 一张工单要求同时改两个仓库（例如 `win-ai-harness/web` 与 `yyjz-oa-frontend/apps/admin` 的镜像页）时，不是「一个工单一个 worktree」，而是**每个工程各建一个 worktree、各一条 `fix/issue-N` 分支**，首句把每个工程的工作区列成一张清单：

```
一工程一工作区（本单 2 个工程，各自一个工作区、互不共用）：
1. yyzl/win-ai-harness
   工作区：~/.foreman/worktrees/win-ai-harness/fix-issue-284
   分支：fix/issue-284（基线 origin/sit-20261126）
2. yyzl/yyjz-oa-frontend
   工作区：~/.foreman/worktrees/yyjz-oa-frontend/fix-issue-284
   分支：fix/issue-284（基线 origin/sit-20261126）
```

- **怎么认工程**：主仓库是工单所在仓库，永远排第一；其余工程从工单标题+正文里的 `owner/name`、`<仓库名>/<子路径>`（如 `win-ai-harness/web`）或单独的仓库名认出来，**只在本产品内认**。仓库名太短（<4 字）只认前两种，避免 `api`、`web` 这类词误命中。
- **认漏了不用交 need_decision**：首句写死「要改的工程不在上面，先 `foreman ws add --repo <工程名|owner/name> --issue <owner/name>#N` 现开一个（幂等，回工作区路径与分支），再进去改」。执行会话不该因为跨工程停下来问人，也不该跑到主 checkout 里去改。
- **边界按工程写**：每个工程只在自己那条工作区里改；不许跨到别的工程目录、不许动各仓库主 checkout、不许动别的目录。
- **PR 也按工程**：每个工程各自 push、各自 `foreman pr open --repo <该工程> --head <分支> --issue N --issue-repo <工单所在仓库>` 开一条；`--issue-repo` 账本靠它把几个工程的 PR 记到同一张单的 `prs[]` 上。
- **收尾也按工程**：每条 PR 合完只清它自己那个工程的工作区；**所有工程的 PR 都合完才关单**（没合完的 close 节点只记一句「还有 n 个工程的 PR 没合」，工单继续 `pr-open`）。
- **自动合并只认单 PR**：RESULT 里 `prs` 多于一条时不自动合（`multi-pr`），交编排逐条核对后 `foreman pr merge`；半合会把另一条 PR 挂空。

补开工作区的命令（跟建 PR、合并一样要经 foreman，因为要写账本）：

```bash
foreman ws add --repo <工程名|owner/name> --issue <owner/name>#<单号> [--base <基线>]   # 幂等：已有就复用
foreman ws list --issue <owner/name>#<单号>                                            # 这条单已经开了哪几个工程
```

## 常驻服务（异步监听）

foreman 是「CLI + 一个常驻服务」：CLI 只负责调度与派活，**谁跑完了、结论是什么，全由服务在后台异步判定并落账**。notify 节点当前只落痕、不发消息；没有同步发送的第二条路。

```bash
foreman serve [--daemon]         # 起服务：前台跑（--daemon 后台，输出进 service.log）
foreman ping                     # 在不在：pid / 版本 / uptime / 在听几条
foreman status                   # 在不在 + 监听明细 + lastPollAt / pollCount / notifiedCount / dwsErrors
foreman watch add <会话id|标题> [--notify <会话id|标题>] [--repo owner/name --number N]  # 登记（派活时通常自动登记）
foreman watch list               # 现在在听哪些
foreman watch rm <会话id|标题>     # 取消登记
foreman watch poll               # 立刻跑一轮（checked / settled / notified），取证补漏
```

- **两条通道（派单 / 合并）**：派单管接活、开会话、续跑；`pickup.maxRunning`（默认 2）**只限制定时巡检**，agent 主动调 `foreman dispatch` 不限在跑上限，派活动作本身串行并抢 `run.lock`。合并管合 PR、关单、清工作区、归档，**1 并发**（`merge.concurrency`），排队在账本 `mergeQueue` 里，由 `merge` 定时器（默认 60s，`merge.cron` 可改）扫。两条通道互不阻塞：正在合 PR 不会挡住派下一张单。`foreman status` 里 `lanes.dispatch` / `lanes.merge` 分别看。

- **自动巡检（`pickup.auto: true`）**：服务自己按 `pickup.intervalSeconds`（默认 1800s）在工作时间窗（`workHours`，默认工作日 08:30–17:30）里捞单，起服务 1s 后先跑一轮；**派单通道并行 2 张单**（`pickup.maxRunning`，默认 2），每轮最多补 `min(空槽, pickup.maxPerRound=2)` 条，和 CLI 的 `foreman run` 抢同一把 `run.lock`，账本 `working` 去重所以不会重复派。**不用外部 cron，也不用守着敲 `foreman run`**。`foreman pickup` 手动催一轮；`foreman status` 的 `pickup` 段看 `maxRunning/inflight/lastAt/count/lastResult`。

- **CLI 启动即握手**（除 `serve` / `help`）：任意子命令起来先读端口文件 `~/.foreman/service.port`（服务写的纯数字），拿它去 `GET /api/ping`；通了直接跑，不通就自动拉起服务、等服务把端口写进文件再连（上限 `handshakeTimeoutMs`，默认 5s）。**CLI 与服务的通信全程 HTTP，没有 unix socket。** 起不来非零退出，打印 `✗ foreman 服务没起来：<原因>` + 两条可执行提示（`foreman serve`、`cat ~/.foreman/service.log`），照做，别手动猜。
- 逃生开关 `--no-service`：跳过握手与自动拉起，只跑这一条命令（测试与排障用）；配置 `service.enabled: false` 等价于一直带它。
- 服务文件都在 `~/.foreman/` 下：`service.port`（实际端口，纯数字一行）、`foreman.pid`（pid/port/http/portFile/启动时间/版本）、`service.log`。重复启动只回「已在运行」（`already-running`），不会起第二个；端口被别的进程占着报 `port-in-use`；停用 SIGTERM 或前台 Ctrl-C。服务监听 `http://127.0.0.1:7317`（`service.http.port`，0 表示系统分配；实际端口写进 `service.port`）；CLI 的每条子命令走 `POST /api/rpc`（body 是 `{id, cmd, …}`），探活走 `GET /api/ping`。排障可以直接 `curl` 这两个路由核对服务状态。没有 `service.http.enabled` 开关——服务起来就一定在听。
- **轮询先读侧边栏、不切窗口**：每轮先 `dws list --json`（`DwsDriver.runningMap`）拿「还在跑」，**在跑的会话直接跳过、不逐条 `dws status`**——`dws status` 内部要 `goto` 切到目标会话，20s 一轮会把用户窗口反复拽到被监听会话上。只有尚未消费且侧边栏显示没在跑的才读 status 取结论；侧边栏读不到时，未消费会话退回逐条 status，已消费会话仍保持 idle，不重复读取。后续由侧边栏重新出现 running，或 `resume` / 重派 steer 显式唤醒。自动巡检同理：有被监听会话还在跑就跳过本轮（`skipped: "window-busy"`），避免豆包单实例下开新会话失败或把 kickoff 发进正在跑的会话。
- 监听节奏沿用 `pollSeconds`（默认 20s）：对登记会话跑 `dws status`，`streaming` 真（running）或 `chars: 0`（pending，dws 的"还没开始"坑）不动；`finished` 真、或 finished/streaming 都假但 `chars > 0` 且有文本（settled）才算跑完；再要求「回复指纹变了」（指纹 = `sha1(chars|head|tail)` 前 12 位）。同一个 `(会话, 指纹)` 只通知一次，去重记在 state.json 的 `notified` 键，服务重启不重发。
- 通知含仓库、单号、结论类别、PR 链接（有则带）；目标取登记的 `notifyTo`，没写取 `notify.session`（`auto` → `MCP_VM_CONVERSATION_ID`）。三种不发：`notify.enabled: false`、目标为空、目标就是被监听会话自己；结论不在 `notify.events` 白名单也不发（显式盯的 `session-done` 例外）。发送失败只写 `service.log`、`dwsErrors++`，不影响继续监听。

## PR 监听（默认 5 分钟一轮）

服务里还有一条独立定时器，每 `prWatch.intervalSeconds`（默认 300s）扫一遍 `repos[]` 下各仓库的 open PR：

- 列表走 `opencli gitea pull-list --repo <owner/name> --state open`（只读适配器命令，带回 `author`）。
- 作者在 `prWatch.ignoreAuthors`（自己的账号，由 `pickup.me` 补齐）里的单跳过，只记 `skipped: "self"`。
- 其余 PR 合成一条消息投递：`deliver.mode: "new"`（默认）**新建一条合并会话**（读合并提示词 + 监控项目，会话名 `foreman-合并-<YYYYMMDD-HHmm>`）；`existing` 才用 `dws notify` 发给 `prWatch.notifyTarget`：`earliest`（默认）= 账本 `sessions` 里最早登记、有 `convId` 的会话（第一个调用方）；也可写死会话 id/侧边栏标题。
- 先按 `pr-view` 的 `mergeNote`/`mergeable` 判冲突，**有冲突的默认过滤掉**（`prWatch.filterConflicts`，默认 `true`；这类单合不了，报了没用，冲突解掉下一轮会自动恢复），记 `skipped: "conflict"`。
- **别人家的 PR 只通知、不在监听里直接合**：监听看不到关联工单，通知合并助手核对并交 `<RESULT>`；`mergeable=true` 的 PR 由 foreman 自动执行 `runMergeTask` 合并。通知里的 `foreman pr merge <N> --repo R` 仅供人工兜底，合不了会直接回理由（`pr-merge` 报错 + `pr-view` 的 `mergeNote`）。
- 去重记在 `state.json` 的 `prWatch` 键（`<repo>#<number>`），发成功才盖 `notifiedAt`；失败下一轮重试，重启不重发。`existing` 模式下账本里还没有调用方时不发也不记账；`new` 模式每次新建会话，不受影响。
- 起服务 1s 后先扫一遍，之后按间隔跑。

```bash
foreman pr poll                  # 立刻扫一轮（checked / notified / target）
foreman pr list                  # 看 PR 监听账本
foreman pr open --repo R --base <基线> --head <分支> --title <标题> [--body <正文>] [--issue <单号>]   # 建 PR（唯一入口）
foreman issue comment <N> --repo R --body <正文>   # 评论工单
foreman issue close <N> --repo R                    # 关单
foreman status                   # 带 prWatch.lastPollAt / pollCount / notifiedCount / pending
```

## 续接调度（planner，默认关）

`planner.enabled: true` 时，续接内容原本并进结论通知一起发（一次一条）。**通知停用期间这段不生效**：内容不再拼进任何消息，函数与账本字段保留，恢复投递后接回即可：

- **跑完是 `done`**、且「在跑的单 < `planner.maxRunning`（默认 2）」、且队列里还有可接工单 → 同一条通知里追加「可以继续接单」+ **工单列表**（仓库/单号/标题 + 我的·无人认领·他人 标签）+ 命令 `foreman run --once`；结论那一行照旧带 PR 链接。
- **跑完不是 `done`**（`need_decision`/`blocked`/`failed`/没 RESULT）→ 同一条通知里追加「需要你看一下」，带状态、原因、分支、PR，并提示 `foreman tasks` 看进度、`foreman retry <仓库> <N>` 放回。
- 去重：同一 `(会话, 回复指纹)` 只提醒一次，记在账本 `planner.lastKey`。
- 目标：`planner.target`（默认 `auto`）= 最早登记的调用方会话；`listLimit` 控制列表条数（默认 5）。
- 「在跑」= 账本里 `state` 为 `planned`/`working` 的单；出结论时状态会推进（done→`pr-open`/`done`，need_decision→`needs-human`，blocked→`blocked`，failed→`failed`）。

```json
"planner": { "enabled": true, "maxRunning": 2, "target": "auto", "listLimit": 5 }
```

## 动手前

1. `foreman doctor` —— 查 dws / opencli / herdr / 各仓库的 `origin/<base>`，零副作用。
2. `foreman run --dry-run --once` —— 打印会捞哪条、worktree 建在哪、首句提示词长什么样，**不建工作区、不动会话**。
3. 真要跑再 `foreman run --once`。**这条命令本身是秒级返回的（异步）**，占着豆包窗口的是它开出来的那条工作会话，一占常是 30–60 分钟，先问用户能不能用。

## 命令

```bash
foreman run --dry-run --once          # 只看计划（会交给谁 / 建在哪 / 发什么）
foreman run --once                    # 跑一轮：捞到单交给编排会话（hand）
foreman run --direct --once           # 这一轮自己派活（老行为，不交给编排）
foreman run --every 1800              # 常驻，每 30 分钟一轮
foreman run --repo win-ai-harness --once
foreman run --notify <会话id|标题>      # 这一轮派出的会话，登记监听时通知目标写谁
foreman run --no-notify                # 这一轮不登记监听，因此不会有通知
foreman orch start                    # 手工兼容入口；自动巡检按工单新建独立编排，不调用它
foreman orch show                     # 每条编排会话（含发起方会话）绑了哪些工作会话、最近 steer 了什么
foreman hand <owner/name>#<N>         # 把工单交给编排会话（不建工作区、不开工作会话）
foreman dispatch <owner/name>#<N> --prompt "<编排指令>"   # 提示词必填：工单分析、任务范围、依赖与验收随首句注入
                                    # 头部自动带完整工单 ID 和 URL；长指令改用 --file <路径>，留空拒绝派单
foreman resume <执行会话id>             # 原会话可修正时：按会话 id steer 续跑（不新开、不传工单号）
                                      # 以上三条都支持 --orchestrator <会话id|标题>：绑到发起方会话
                                      #（不传则取 MCP_VM_CONVERSATION_ID，即「用户自己发起的会话」）
foreman clean <owner/name>#<N>        # 合并关单后清 worktree / 分支 / 工作会话 / 本单编排会话（幂等）
foreman clean --all                   # 清所有终端态工单的残留
foreman tasks                         # 每条工单到哪一步、卡在哪
foreman pr poll                       # 立刻扫一轮 PR（作者不是自己的（pickup.me）报给最早登记的调用方）
foreman pr list                       # 看 PR 监听账本
foreman pr open --repo R --head <分支> --title <标题> --body <自证> --issue <N>   # --base 省略时取配置 repos[].base
foreman pr open --repo R ... --issue <N> --issue-repo <工单所在仓库>   # 跨工程：把这条 PR 记到那张单上
foreman pr merge <N> --repo R         # 幂等合并 + 推进 done/关单（所有工程的 PR 都合完才关单）
foreman ws add --repo <工程> --issue <owner/name>#<N>   # 一工程一工作区：跨工程时现开一个（幂等）
foreman ws list --issue <owner/name>#<N>               # 看这条单已开了哪几个工程的工作区
foreman issue comment <N> --repo R --body <正文>   # 可选：顺手落库，非必须
foreman issue close <N> --repo R                    # 可选：顺手落库，非必须
foreman retry win-ai-harness 255      # 人工处理完，放回队列（attempts 清零）
foreman doctor [--start]              # --start 才真的连豆包窗口读状态
```

`-c <文件>` 与 `--config <文件>` 等价；默认读 `./foreman.json` → `~/.foreman/config.json`。

## 一轮的流程

0. **会话中心（默认）先交给本单编排**：捞到单不直接建工作区，而是 `ensureIssueOrchestrator`（这张单独立一条编排会话，按单幂等）+ `dws msg --mode steer` 把工单交进去，账本记 `handed` 与 `orchestrator`；编排读完调 `foreman dispatch` 才走下面 2、3 步。失败/卡住由编排先归因：原会话可修正就 `foreman resume <执行会话id>`，需要其他智能体就补派并登记监听，完成后 steer 回原会话；合完调 `foreman clean`。
1. `opencli gitea search --label <id>` 拉 open 工单，按 `pickup` 过滤（排除人工标签、已处理的、到重试上限的），**三档排序**：我的（作者是 `pickup.me`）→ 无人认领 → 他人，同档最老先接（`pickup.priority` 可改顺序）。
2. 工单牵涉几个工程（主仓库 + 正文里提到的本产品其它工程）就各建一个工作区：`herdr worktree create --cwd <该工程> --branch fix/issue-N --base origin/<base> --path ~/.foreman/worktrees/<该工程>/fix-issue-N --no-focus`。**一个工程一个工作区，不合并、不共用。**
3. `dws open --name foreman-<工单所在仓库>-<N>` 发 kickoff：把工单正文、**每个工程的工作区与分支清单**、边界（**一工程一工作区：每个工程只在自己那条工作区里改，不许跨目录、不许动主 checkout；缺工作区就交 blocked 写「缺工作区：<owner/name>」**）、**「改完就 commit 然后结束」**（不 push、不开 PR、不合并、不关工单、不动 worktree 与会话——**工作会话不认识 foreman，提示词里也不出现 foreman 命令**；想读工单细节用 `opencli gitea issue-view --repo <仓库> <N>` 只读）、`<RESULT>` 协议一次写进去。
4. **这一条是异步的，派完就结束**：返回 `dispatched` 即收工——**不等回复、不读 RESULT、不验收、不重派**。会话本身要跑很久（30–60 分钟是常态，实测 50 分钟收工），期间别去 `dws status` 盯它（会挤服务轮询）。会话跑完由服务在后台轮询判定，用 `dws info` 读最后一条、从里面取最后一个 `<RESULT>` 块映射结论，推进工单状态与账本；**会话中心下这条结论还会 `dws msg --mode steer` 进这张单绑定的编排会话**（带 `下一步：pr merge / resume / clean`），不再新建会话、不再通知；`done` 但没 PR 时 foreman 会先自己 push + 开 PR 再 steer（开不出来就把这条当失败，交编排 `resume` 同一条会话）。**验收以会话自交的 RESULT 与其自证为准（它跑了什么、输出是什么），调用方不要为了「再确认一遍」重跑单测**——重复验证只会把一轮拖成两轮；只有确实怀疑结果时才跑，并先说明为什么要跑。
5. 收口是「会话交提交、foreman 交 PR」：工作会话 `done` 时工作区必须干净、分支上有提交（RESULT 里只写 `tests` 与 `summary`，不写 prs）；foreman 一看到 done 就自己 push 分支、按工程各开一条 PR，PR 号/链接写进账本再 steer 进编排（开不出来就当失败，交编排 `resume` 同一条会话）。合并仍然只有一条路：编排核对后 `foreman pr merge`（`merge.enabled: true` 时也可由合并通道按队列自动合），**工作会话不 push、不开 PR、不合并**。`verify` / `publish` 代码还在但没接线。
6. `need_decision` / `blocked`：结论落账、工单进停态（通知停用期间不发消息），**worktree 留着**；人处理完 `foreman retry <仓库> <N>` 放回队列。

RESULT 协议（只认最后一个块，差一点按失败处理）：

```
<RESULT>{"status":"done","prs":[{"repo":"yyzl/win-ai-harness","branch":"fix/issue-250","pr":251,"prUrl":"http://…/pulls/251"}],"tests":"mvn -q test 通过","summary":"改了 A"}</RESULT>
```

`status` 只能是 `done` / `need_decision` / `blocked` / `failed`；`done` 只表示「改完、自测通过、已 commit」，RESULT 里只写 `tests` 与 `summary`，**不写 prs**（PR 由 foreman 在 done 之后自己 push + 开，编号与链接进账本）。合并由 foreman 做，工作会话不碰。

## 状态与文件

- 账本 `~/.foreman/state.json`：`orchestrator`（手工兼容入口的全局编排 `{convId,name,at}`；自动巡检认 `issues[键].orchestrator`）、`steers`（steer 留痕）、`issues`（工单进度、分支、worktree、`workspaces`（每个工程一条 `{repo,branch,worktree}`）、`prs`（每个工程一条 PR）、`agent` / `agentConvId` / `orchestrator`（绑定的工作会话）、attempts、lastFailure）、`planner`（续接提醒去重 `lastKey`）、`sessions`（会话名、convId、最后回复、`kind` = `worker`/`orchestrator`/`deliver:*`、`parent`）、`watch`（显式登记的监听）、`notified`（已通知指纹去重）、`prWatch`（PR 监听去重：`<repo>#<number>`）、`mergeQueue`（合并通道排队：`<repo>#<pr>` → `queued`/`running`/`merged`/`failed`）、`mergeAsk`（合并去重：`<repo>#<pr>` → `merged`/`failed`）
- 服务 `~/.foreman/service.port`（端口）/ `foreman.pid` / `service.log`
- 日志 `~/.foreman/run.log`；锁 `~/.foreman/run.lock`（**只管派单通道**，合并通道不碰它）
- 工作区 `~/.foreman/worktrees/<工程>/fix-issue-N`（分支名里的 `/` 换成 `-`；**一工程一个目录，跨工程时同一张单在几个工程目录下各有一份**）
- 工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`
  `done`、`pr-open`、`needs-human`、`blocked`、`escalated` 都不会再被自动捞。

## 配置要点

- **基线写在配置 `repos[].base`**（配了 `products` 就是 `products[].repos[].base`；本工程当前是 `sit-20261126`），代码和命令都不写死；分支从 `origin/<base>` 拉，验收按 `origin/<base>..HEAD` 算。
- **产品分组 `products[]`**：一个产品 = 一套自己的项目群（`repos[]`）+ `projectDir`（派单/合并两份提示词默认用代码内置的 `src/builtin/dispatch-prompt.md` / `merge-prompt.md`，想单独换一份才写 `promptFile` / `mergePromptFile`）。配了 `products` 就以它为准（顶层 `repos` 只在没有 products 时用），捞单/PR 扫描/投递都按产品走；产品没写 `promptFile`/`mergePromptFile`/`projectDir` 时回落顶层 `deliver` 同名配置（`mergePromptFile` 再回落 `promptFile`），全空就用内置。**加新产品只改配置**：加一段 products（提示词可不写），重启服务，不动代码。
- **自动巡检 `pickup.auto`**：服务自己按 `pickup.intervalSeconds`（默认 1800s）在 `workHours` 窗口里捞单（派单通道并行 2 张单，`maxRunning: 2`；每轮最多补 `maxPerRound: 2` 条），不需要外部 cron；`foreman pickup` 手动催一轮。`pauseWhileRunning: true` 才回到「有会话在跑就不开新会话」的老行为。
- **`pickup.labelIds` 必须是数字 id**：`opencli gitea search` 的列表结果不回 labels，按名字配会静默捞 0 条；查 id 用 `label-list`（`ready-for-agent` = 5）。配了 `labelIds` 后 foreman 不再拿名字做二次过滤。
- `merge.enabled` 默认 **false**：只开 PR 不合并。设 `true` 即自动合并，**合并走独立通道**（`merge.concurrency` 默认 1、`merge.intervalSeconds` 默认 60 扫队列）：派单侧只入队不阻塞，合 PR / 关单 / 清工作区由合并通道（或 `foreman pr merge`）做；执行会话不碰合并，冲突/失败只通知不重试。
- **续接调度**：`planner.enabled` 默认 **false**；开了就是一个跑完、槽位 `< maxRunning`、还有活就催编排继续接，不是 done 就催它去查（详见上面「续接调度」）。
- **接单三档**：`pickup.priority` 默认 `["mine","unassigned","others"]`，`pickup.me` 从配置读（自己的 Gitea 账号）；「我的」按工单作者（`creator`）认定。`onlyUnassigned: true` 会把「他人」整档排除。**在飞工单（账本 `working` 且无 `lastFailure`）不再被捞单**：续跑只由编排 AI / `foreman retry` 触发，否则每轮巡检都会给同一张单重发一次「继续处理」；只有派单失败（有 `lastFailure`）且 `attempts < maxAttempts` 的才会被自动重试。
- **会话中心默认开**：`sessionFlow.enabled`（默认 `true`）——自动巡检每张工单各有一条编排会话，命名为 `<deliver.namePrefix>-<仓库>-<单号>-编排` 并写入 `issues[键].orchestrator`；`promptFile` 留空用内置 `src/builtin/orchestrator-prompt.md`，`projectDir` 留空回落 `deliver.projectDir`，`waitFirstReply` 默认 `false`。`pickup.handToOrchestrator`（默认 `true`）= 自动巡检捞到单先 `hand` 给本单编排，由它调 `dispatch`。用户从当前会话主动派单则直接绑定当前会话。关掉这两个开关（或 `run --direct`）退回老的多会话模型；PR 的 `deliver.mode=new` 新建合并会话不受 sessionFlow 影响。
- **服务没在跑时没人判结论**（异步的代价，不是 bug）：补法是 `foreman watch list` 看登记还在不在 → `foreman watch poll` 立刻重放一轮 → `foreman status` 看 `lastPollAt` / `pollCount` / `dwsErrors`。
- **工作时间窗**：`workHours`（`enabled`、`days` 1=周一…7=周日、`start`/`end` 如 `08:30`–`18:30`、`offUntil` 临时闭嘴）。两套定时轮询（会话监听 + PR 扫描）只在窗口内跑；窗口外一律跳过，手动 `foreman watch poll` / `foreman pr poll` 不受限。`foreman status` 的 `workHours.active` 就是当前是否在跑。
- **PR 监听**：`prWatch.enabled`（默认 `true`）、`intervalSeconds`（默认 300）、`ignoreAuthors`（自己的 Gitea 用户名，由 `pickup.me` 补齐）；`deliver.mode=new` 时新建合并会话，`notifyTarget` 只供 `deliver.mode=existing` 选择已有会话。要停就 `enabled: false`。
- **`service.enabled: false`** 等价于一直带 `--no-service`：子命令不握手、不自动拉起；`pidFile` / `logFile` / `service.http.portFile` 可改路径（测试用临时目录）。
- `verify` 是逐条 `bash -lc` 跑在 worktree 里的命令；`[]` 表示只查"干净 + 有提交"。
- `herdr.enabled: false` 或 herdr 报错时退回 `git worktree add`，日志里有原因。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `{"ok":false,"error":"app_unavailable"}` / 提示 `app_busy` | 用户自己开着的豆包占了单实例 | 让用户 ⌘Q 退出豆包再跑；**不要换 profile、不要反复重试** |
| `{"ok":true,"skipped":"locked"}` | 上一轮还在跑（`~/.foreman/run.lock` 里的 pid 还活着） | 等它跑完；别在进程活着时删锁 |
| 派完半小时一条消息都没有 | **多半是正常**：工作会话跑 30–60 分钟（实测 50 分钟）才 commit 交 RESULT，异步就是要等 | 别重派、别守 `dws status`；`foreman tasks` / `foreman orch show` 看进度，服务在跑就等结论 `steer` 回来；确认服务在跑用 `foreman ping` |
| 工单一直没人接 | 看 `foreman tasks`；`needs-human`/`blocked`/`escalated`/`pr-open` 都已停 | 人处理完 `foreman retry <仓库> <N>` |
| 派单不派了、一直 `slots-full` | 已有 2 张单在跑（`pickup.maxRunning`），槽位满 | `foreman tasks` 看是哪两张；跑完/`retry` 后再催 `foreman pickup` |
| 合并不发生、`pr` 一直挂着 | `merge.enabled` 关了、`mergeQueue` 里那条 `failed`、或 `tests` 自证为空（不自动合） | `foreman status` 看 `lanes.merge` 与 `merge.queued`；修好后 `foreman pr merge <N> --repo R` 手动走同一条通道 |
| 一条也捞不到 | `labelIds` 配的 id 不对、`excludeLabels` 命中、已指派且 `onlyUnassigned` | `foreman run --dry-run --once` 看"open N 条，可接 M 条"，顺带看它给每张单列了几个工程的工作区 |
| 跨工程单交 `need_decision`「要求改另一个仓库」 | 首句把边界写死在单一 worktree（老行为），或工程没认出来 | 看 `foreman tasks` / 账本 `workspaces` 有几条；不够就 `foreman ws add --repo <工程> --issue <单号>` 补开，再 `foreman retry` 放回 |
| 工单合了一条 PR 还是 `pr-open`、没关单 | 一工程一工作区：还有别的工程的 PR 没合 | `foreman ws list --issue <单号>` 看 `prs`；逐条 `foreman pr merge <N> --repo <该工程>`，全合完 close 节点才关单 |
| 工作会话失败后又冒出一条新会话 | 走的不是 `resume`（直接 `dispatch` 时账本没绑上） | `foreman orch show` 看 `agentConvId`；用 `foreman resume <执行会话id>`，它只 steer 指定会话 |
| 编排会话收不到更新 | 工单没绑定 `issues[键].orchestrator`，或 `openNew` 没拿到 convId | `foreman orch show` 看这张单的 orchestrator；空就重新 `foreman hand <owner/name>#N`，让它新建/复用本单编排 |
| `clean` 说 worktree 保留 | 工作区有未提交改动（不删别人正在写的东西） | 进 worktree 看一眼，commit 或确认无需后重跑 `foreman clean` |
| 侧边栏堆着一排「工单编排」会话 | 工单收口后这张单自己的编排会话没被归档（`clean` 早先只管工作会话）；已修：`clean` 与服务每轮巡检都会收 | 先看服务在跑（`foreman ping`）；想立刻收就 `foreman clean --all`（只收 `done`/`cleaned` 的单，全局编排与你自己发起的会话不动） |
| `ws add` 报「没处理过这条工单」 | `--issue` 写法不对（要 `<owner/name>#<单号>`，用首句里的「工单键」） | 照首句抄；账本里确实没有就先 `foreman run --once` 派单 |
| 验收失败「工作区还有未提交改动」 | 会话没 commit 或留了临时文件 | 验收不在 run 里自动跑；手动发现就让会话补 commit，或进 worktree 看一眼 |
| 验收失败「分支上没有新提交」 | 会话只看了没改，或改在别的分支 | 同上；进 worktree 手动看一眼，必要时 `foreman retry <仓库> <N>` 放回队列 |
| `opencli ... 失败" | Gitea 登录态 / 权限 | 让用户在 Chrome 登录 Gitea；401 别循环重跑 |
| herdr 建不动 | server 没起 / 仓库没信任 | `herdr status`；foreman 会退回 `git worktree add` 并写日志 |
| 报 `service_unavailable` /「服务没起来」 | 常驻服务没跑、自动拉起超时或 spawn 失败 | 照提示走：`foreman serve`，再 `cat ~/.foreman/service.log`；急着单跑一条用 `--no-service` |
| `already-running` | 单实例判活：端口文件里的端口 ping 得通 | 正常，直接用现有服务；别起第二个抢端口 |
| 报 `port-in-use` | 端口被别的进程占着（ping 不通） | 改 `service.http.port`，或停掉占端口的进程；端口文件会自动更新 |
| `watch list` 里看不到某条会话 | 派活时被 `--no-notify` 标了 `notify:false`，或 `watch rm` 过 | 需要就 `foreman watch add <会话id|标题>` 显式补登 |
| 会话跑完却没收到通知 | 服务没在跑（通知丢）、会话没登记、或没配目标/被事件过滤 | `foreman watch list` 看在不在听；`foreman watch poll` 立刻重放补一轮；`foreman status` 看 `lastPollAt` / `pollCount` / `dwsErrors`；再查 `service.log` 里的发送失败原因 |

收尾：`escalated` 的单、以及被停掉的轮次留下的 worktree，用 `git -C <repo> worktree list` 确认后在仓库里
`git worktree remove --force <path>`、需要时 `git branch -D fix/issue-N`。
