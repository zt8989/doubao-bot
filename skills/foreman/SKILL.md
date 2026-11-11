---
name: foreman
description: 接单编排 CLI（项目 foreman，命令 foreman）：用 opencli 读内网 Gitea 的 ready-for-agent 工单、用 herdr 从 origin/<base> 开 worktree、用 dws 把活派给豆包会话后立即返回（不验收、不 push：会话自测通过后自己 push，并经 `foreman pr open` 开 PR，PR/工单写操作都收口在 foreman），常驻服务异步监听会话、跑完把结论与 PR 回通知。当用户说自动接单、接工单、把工单派给豆包、批量跑 Gitea 工单、看某条工单处理到哪、把卡住的单放回队列，或提到 foreman 时报 app_busy / locked / pr-open 时使用。dws 只管豆包会话、opencli 只管 Gitea、herdr 只管 worktree，串联是 foreman 的事。它带一个常驻服务：CLI 每次启动先跟服务握手，会话由服务异步监听，跑完再回通知（只有异步一条路径，没有同步发送）。整条链路的验收口径见 workflow。提到 foreman 但报「服务没起 / service_unavailable / 监听没收到」也用本技能。
---

# foreman：接单编排

一个独立 CLI，源码在 `/Users/zhouteng/Documents/workspace/doubao-bot/foreman`（`doubao-bot` 工程里的子包），已 `npm link` 成全局 `foreman`。改源码立即生效。

它不实现任何下层能力，只做串联：

| 依赖 | 负责 | 谁的前提 |
| --- | --- | --- |
| `opencli gitea` | 工单/PR 读写（复用 Chrome 登录态） | Chrome 里已登录 Gitea；每条命令 20–40s |
| `herdr` | 建 git worktree（顺带在 herdr 里挂工作区） | `herdr` server 在跑（`herdr status`） |
| `dws` | 豆包会话（开会话/续说/读状态/读对话） | 豆包**单实例**，用户自己开着时要先 ⌘Q |

## 常驻服务（异步监听）

foreman 是「CLI + 一个常驻服务」：CLI 只负责调度与派活，**谁跑完了、结果是什么、要通知谁，全由服务在后台异步完成**。没有同步通知的第二条路。

```bash
foreman serve [--daemon]         # 起服务：前台跑（--daemon 后台，输出进 service.log）
foreman ping                     # 在不在：pid / 版本 / uptime / 在听几条
foreman status                   # 在不在 + 监听明细 + lastPollAt / pollCount / notifiedCount / dwsErrors
foreman watch add <会话id|标题> [--notify <会话id|标题>] [--repo owner/name --number N]  # 登记（派活时通常自动登记）
foreman watch list               # 现在在听哪些
foreman watch rm <会话id|标题>     # 取消登记
foreman watch poll               # 立刻跑一轮（checked / settled / notified），取证补漏
```

- **CLI 启动即握手**（除 `serve` / `help`）：任意子命令起来先读端口文件 `~/.foreman/service.port`（服务写的纯数字），拿它去 `GET /api/ping`；通了直接跑，不通就自动拉起服务、等服务把端口写进文件再连（上限 `handshakeTimeoutMs`，默认 5s）。**CLI 与服务的通信全程 HTTP，没有 unix socket。** 起不来非零退出，打印 `✗ foreman 服务没起来：<原因>` + 两条可执行提示（`foreman serve`、`cat ~/.foreman/service.log`），照做，别手动猜。
- 逃生开关 `--no-service`：跳过握手与自动拉起，只跑这一条命令（测试与排障用）；配置 `service.enabled: false` 等价于一直带它。
- 服务文件都在 `~/.foreman/` 下：`service.port`（实际端口，纯数字一行）、`foreman.pid`（pid/port/http/portFile/启动时间/版本）、`service.log`。重复启动只回「已在运行」（`already-running`），不会起第二个；端口被别的进程占着报 `port-in-use`；停用 SIGTERM 或前台 Ctrl-C。
- 监听节奏沿用 `pollSeconds`（默认 20s）：对登记会话跑 `dws status`，`streaming` 真（running）或 `chars: 0`（pending，dws 的"还没开始"坑）不动；`finished` 真、或 finished/streaming 都假但 `chars > 0` 且有文本（settled）才算跑完；再要求「回复指纹变了」（指纹 = `sha1(chars|head|tail)` 前 12 位）。同一个 `(会话, 指纹)` 只通知一次，去重记在 state.json 的 `notified` 键，服务重启不重发。
- 通知含仓库、单号、结论类别、PR 链接（有则带）；目标取登记的 `notifyTo`，没写取 `notify.session`（`auto` → `MCP_VM_CONVERSATION_ID`）。三种不发：`notify.enabled: false`、目标为空、目标就是被监听会话自己；结论不在 `notify.events` 白名单也不发（显式盯的 `session-done` 例外）。发送失败只写 `service.log`、`dwsErrors++`，不影响继续监听。
- **控制台与 CLI 共用一条 HTTP**：服务只监听 `http://127.0.0.1:7317`（`service.http.port`，0 表示系统分配；实际端口写进 `service.port`）。CLI 走 `POST /api/rpc`（body 是 `{id, cmd, …}`）、探活走 `GET /api/ping`；浏览器访问 `/`。接口：`GET /api/snapshot`（当天任务 + PR）、`GET /api/polls`、`POST /api/sync`（立刻扫一轮）。数据落在 SQLite `~/.foreman/console.db`，唯一键 `<owner>/<repo>#<number>`，按工单去重、重复同步不多出行。`tasks` 表带 `agent` 列（派给哪个会话），可按会话统计。`foreman pr open` / `foreman issue comment|close` 写完立刻 `sync` 落库，控制台不用等下一轮。没有 `service.http.enabled` 开关——HTTP 是唯一通道，服务起来就一定在听。

## PR 监听（默认 5 分钟一轮）

服务里还有一条独立定时器，每 `prWatch.intervalSeconds`（默认 300s）扫一遍 `repos[]` 下各仓库的 open PR：

- 列表走 `opencli gitea pull-list --repo <owner/name> --state open`（只读适配器命令，带回 `author`）。
- 作者在 `prWatch.ignoreAuthors`（自己的账号，由 `pickup.me` 补齐）里的单跳过，只记 `skipped: "self"`。
- 其余 PR 先合并，结果合成一条消息，用 `dws notify` 发给 `prWatch.notifyTarget`：`earliest`（默认）= 账本 `sessions` 里最早登记、有 `convId` 的会话（第一个调用方）；也可写死会话 id/侧边栏标题。
- 先按 `pr-view` 的 `mergeNote`/`mergeable` 判冲突，**有冲突的默认过滤掉**（`prWatch.filterConflicts`，默认 `true`；这类单合不了，报了没用，冲突解掉下一轮会自动恢复），记 `skipped: "conflict"`。
- **别人家的 PR 只通知、不在监听里合**：监听看不到关联工单，通知里带 `foreman pr merge <N> --repo R`，由编排 agent 核对工单后再合；合不了 `foreman pr merge` 直接回理由（`pr-merge` 报错 + `pr-view` 的 `mergeNote`）。
- 去重记在 `state.json` 的 `prWatch` 键（`<repo>#<number>`），发成功才盖 `notifiedAt`；失败下一轮重试，重启不重发。账本里还没有调用方时不发也不记账，等有了补发。
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

服务每轮 poll 判定完一条会话后，**把续接内容并进同一条通知**（不另发一条），让编排 agent 一次看清“这条结了什么 + 还剩什么”：

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
3. 真要跑再 `foreman run --once`。这一跑会长时间占着豆包窗口，先问用户能不能用。

## 命令

```bash
foreman run --dry-run --once          # 只看计划
foreman run --once                    # 跑一轮（每仓库 perRepoPerRound 条）
foreman run --every 1800              # 常驻，每 30 分钟一轮
foreman run --repo win-ai-harness --once
foreman run --notify <会话id|标题>      # 这一轮派出的会话，登记监听时通知目标写谁
foreman run --no-notify                # 这一轮不登记监听，因此不会有通知
foreman tasks                         # 每条工单到哪一步、卡在哪
foreman pr poll                       # 立刻扫一轮 PR（作者不是自己的（pickup.me）报给最早登记的调用方）
foreman pr list                       # 看 PR 监听账本
foreman pr open --repo R --head <分支> --title <标题> --body <自证> --issue <N>   # --base 省略时取配置 repos[].base
foreman issue comment <N> --repo R --body <正文>
foreman retry win-ai-harness 255      # 人工处理完，放回队列（attempts 清零）
foreman doctor [--start]              # --start 才真的连豆包窗口读状态
```

`-c <文件>` 与 `--config <文件>` 等价；默认读 `./foreman.json` → `~/.foreman/config.json`。

## 一轮的流程

1. `opencli gitea search --label <id>` 拉 open 工单，按 `pickup` 过滤（排除人工标签、已处理的、到重试上限的），**三档排序**：我的（作者是 `pickup.me`）→ 无人认领 → 他人，同档最老先接（`pickup.priority` 可改顺序）。
2. `herdr worktree create --cwd <repo> --branch fix/issue-N --base origin/<base> --path ~/.foreman/worktrees/<仓库>/fix-issue-N --no-focus`。
3. `dws open --name foreman-<仓库>-<N>` 发 kickoff：把工单正文、worktree、分支、边界（**只在这个 worktree 改；自测通过后自己 `git push -u origin <分支>`，再用 `foreman pr open --repo <仓库> --base <base> --head <分支> --title … --body … --issue <N>` 开 PR（**PR/工单写操作只走 foreman**，账本与控制台才记得到；工单评论/关单用 `foreman issue comment|close`），PR 号/链接写进 RESULT；不合并、不 force push**）、`<RESULT>` 协议一次写进去。
4. run 派活后就返回 `dispatched`：不等回复、不读 RESULT、不验收、不 push/PR。会话跑完由服务在后台轮询判定，用 `dws info` 读最后一条、从里面取最后一个 `<RESULT>` 块映射结论，再发通知；RESULT 里的 `pr` / `prUrl` 优先于账本，通知正文直接带 PR 链接。**验收以会话自交的 RESULT 与其自证为准（它跑了什么、输出是什么），调用方不要为了「再确认一遍」重跑单测**——重复验证只会把一轮拖成两轮；只有确实怀疑结果时才跑，并先说明为什么要跑。
5. 收口是「会话交 PR、服务通知人」：会话 `done` 时必须已 push 且开了 PR，通知里带 PR 号与链接、`tests` 自证。`merge.enabled: true` 时由**编排自己**合并（`opencli gitea pr-merge` + `close`），执行会话只 push + 开 PR、不合并；同一 PR 只合一次（账本 `mergeAsk` 记 `<repo>#<pr>`，状态 `merged`/`failed`），`tests` 为空则不自动合，冲突只记录、不 force merge。foreman 侧不 push；PR 由会话发起、经 `foreman pr open` 落地，工单写操作同样走 foreman，否则控制台统计断档。`verify` / `publish` 代码还在但没接线。
6. `need_decision` / `blocked`：结论由服务通知到人，**worktree 留着**；人处理完 `foreman retry <仓库> <N>` 放回队列。

RESULT 协议（只认最后一个块，差一点按失败处理）：

```
<RESULT>{"status":"done","branch":"fix/issue-250","pr":251,"prUrl":"http://…/pulls/251","tests":"mvn -q test 通过","summary":"改了 A"}</RESULT>
```

`status` 只能是 `done` / `need_decision` / `blocked` / `failed`；`done` 必须带 `pr` 与 `prUrl`（会话自己 push、经 `foreman pr open` 开 PR 的结果）。合并由 foreman 做，会话不用回交合并结果。

## 状态与文件

- 账本 `~/.foreman/state.json`：`issues`（工单进度、分支、worktree、attempts、lastFailure、`agent`）、`planner`（续接提醒去重 `lastKey`）、`sessions`（会话名、convId、最后回复）、`watch`（显式登记的监听）、`notified`（已通知指纹去重）、`prWatch`（PR 监听去重：`<repo>#<number>`）、`mergeAsk`（合并去重：`<repo>#<pr>` → `merged`/`failed`）
- 服务 `~/.foreman/service.port`（端口）/ `foreman.pid` / `service.log`
- 日志 `~/.foreman/run.log`；锁 `~/.foreman/run.lock`
- 工作区 `~/.foreman/worktrees/<仓库>/fix-issue-N`（分支名里的 `/` 换成 `-`）
- 工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`
  `done`、`pr-open`、`needs-human`、`blocked`、`escalated` 都不会再被自动捞。

## 配置要点

- **基线写在配置 `repos[].base`**（本工程当前是 `sit-20261126`），代码和命令都不写死；分支从 `origin/<base>` 拉，验收按 `origin/<base>..HEAD` 算。
- **`pickup.labelIds` 必须是数字 id**：`opencli gitea search` 的列表结果不回 labels，按名字配会静默捞 0 条；查 id 用 `label-list`（`ready-for-agent` = 5）。配了 `labelIds` 后 foreman 不再拿名字做二次过滤。
- `merge.enabled` 默认 **false**：只开 PR 不合并。设 `true` 即自动合并，**合并由编排执行**（`merge.by: foreman`，默认）；执行会话不碰合并，冲突/失败只通知不重试。
- **续接调度**：`planner.enabled` 默认 **false**；开了就是一个跑完、槽位 `< maxRunning`、还有活就催编排继续接，不是 done 就催它去查（详见上面「续接调度」）。
- **接单三档**：`pickup.priority` 默认 `["mine","unassigned","others"]`，`pickup.me` 从配置读（自己的 Gitea 账号）；「我的」按工单作者（`creator`）认定。`onlyUnassigned: true` 会把「他人」整档排除。
- **通知默认开、且只有异步这一条**：会话跑完后由**服务**用 `dws send` 回给登记的通知目标（`notify.session: "auto"` 取 `MCP_VM_CONVERSATION_ID`，也可写会话 id/侧边栏标题），run 自己不发。`--no-notify` = 这一轮派出的会话**不登记给服务监听、因此不会有通知**（不是「换个方式同步发」）；`notify.enabled: false` 永久关；`--notify <会话id|标题>` 只改登记时的通知目标。不发的三种情况：目标为空、目标就是这条单自己的执行会话 `foreman-<仓库>-<N>`、结论不在 `notify.events` 白名单（显式盯的 `session-done` 例外）。
- **服务没在跑时通知会丢**（异步的代价，不是 bug）：补法是 `foreman watch list` 看登记还在不在 → `foreman watch poll` 立刻重放一轮 → `foreman status` 看 `lastPollAt` / `pollCount` / `dwsErrors`。
- **PR 监听**：`prWatch.enabled`（默认 `true`）、`intervalSeconds`（默认 300）、`ignoreAuthors`（自己的 Gitea 用户名，由 `pickup.me` 补齐）、`notifyTarget`（`earliest` 取最早登记的调用方）。要停就 `enabled: false`。
- **`service.enabled: false`** 等价于一直带 `--no-service`：子命令不握手、不自动拉起；`pidFile` / `logFile` / `service.http.portFile` 可改路径（测试用临时目录）。
- `verify` 是逐条 `bash -lc` 跑在 worktree 里的命令；`[]` 表示只查"干净 + 有提交"。
- `herdr.enabled: false` 或 herdr 报错时退回 `git worktree add`，日志里有原因。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `{"ok":false,"error":"app_unavailable"}` / 提示 `app_busy` | 用户自己开着的豆包占了单实例 | 让用户 ⌘Q 退出豆包再跑；**不要换 profile、不要反复重试** |
| `{"ok":true,"skipped":"locked"}` | 上一轮还在跑（`~/.foreman/run.lock` 里的 pid 还活着） | 等它跑完；别在进程活着时删锁 |
| 工单一直没人接 | 看 `foreman tasks`；`needs-human`/`blocked`/`escalated`/`pr-open` 都已停 | 人处理完 `foreman retry <仓库> <N>` |
| 一条也捞不到 | `labelIds` 配的 id 不对、`excludeLabels` 命中、已指派且 `onlyUnassigned` | `foreman run --dry-run --once` 看"open N 条，可接 M 条" |
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
