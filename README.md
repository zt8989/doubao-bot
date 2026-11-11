# doubao-bot

一个工程，三个命令，一个工具只管一件事：

| 命令 | 源码 | 管什么 |
| --- | --- | --- |
| `dws` | `bin/dws.mjs` + `src/` | 豆包会话：开会话、发指令、看状态、取对话、续说、打断、归档 |
| `foreman` | `foreman/`（子包，独立 `package.json`） | 接单编排：opencli 读工单 → herdr 开 worktree → dws 派活 → 验收 → push/开 PR |
| `opencli gitea` | `adapters/gitea/` | 内网 Gitea 读写（复用 Chrome 登录态） |

技能在 `skills/`：`dws`、`foreman`、`gitea-opencli`。skill root 下的同名目录都是
指向这里的**软链**，改这里就等于改技能。

gitea 适配器是**文件级软链**：`~/.opencli/clis/gitea` 必须保持真目录（opencli 的发现
逻辑只扫 `entry.isDirectory()`，目录整体软链会让整条 `gitea` 命令消失），里面的 `.js`
逐个软链到 `adapters/gitea`。克隆或新增/删除适配器文件后跑一次：

```bash
bash scripts/link-adapter.sh     # 建文件软链 + 让适配器 import 能解析到全局 opencli 包
```

`dws` 与 `foreman` 都 `npm link` 成了全局命令，源码改动不需要重装。

## dws：只管豆包会话

把豆包（豆包 / 豆包工作）当成可以脚本化的执行器：**开会话、发指令、看会话状态、取会话信息**。
它只管这一件事——不碰工单、不碰 PR、不碰 git 远端。要接单、要提 PR 用 `foreman`，
dws 只提供「把一段活交给豆包并读到结果」这个能力。

驱动方式参考 magpie 的 `doubao-work` 插件：不碰豆包云端的 API（它没有），
而是从**独立 profile** 拉起桌面端、开 CDP 调试端口，像人一样新建「工作任务」、
切模式、填输入、读回复。`src/cdp.mjs`、`src/doubao.mjs` 里的页面操作就是从那套实现改的。

## 它做什么，不做什么

做：

- 开一条「工作任务」（会话），把第一句提示词发出去，等到回复结束。
- 查这条会话跑到哪了、取整段对话（含思考）、续说、追加指令、中断、归档。
- 跨进程复用同一条会话（按会话名或任务 id 定位）。

不做（历史上做过，已削掉）：拉 Gitea 工单、按标签挑单、建 worktree、跑验收命令、
push / 开 PR / 合并 / 关单、工单留言、挂起与重试队列、定时接单。

## 前置条件（重要）

1. **豆包一次只能开一个副本。** 你自己开着的豆包会占住单实例，`dws` 起不来（报 `app_busy`）。
   跑之前先 **⌘Q 退出豆包**；`dws` 会用自己的 profile 起一个窗口，这个窗口你可以同时用。
2. 这个 profile 默认复用 magpie 的 `~/Library/Application Support/magpie-doubao-work`，
   里面已经登录过豆包。换 profile 用 `DOUBAO_WORK_HOME`，换二进制用 `DOUBAO_WORK_APP`。
3. Node ≥ 22（用到内置 `WebSocket` / `fetch`）。

## 安装

```bash
cd ~/Documents/workspace/doubao-bot
npm link          # 全局安装：之后任何地方都能用 dws
# 或者不 link，直接 node bin/dws.mjs …

# 全局安装推荐把配置放 ~/.dws/config.json（默认会找 ./config.json，其次 ~/.dws/config.json）
mkdir -p ~/.dws && cp config.example.json ~/.dws/config.json

dws doctor                           # 自检；--start 会真的拉起豆包查登录态
```

## 命令

```bash
# 开一条会话（新建工作任务；带 prompt 就顺带把第一句发出去并等它跑完）
dws open --name win-ai-harness --repo yyzl/win-ai-harness --prompt "先看一眼仓库现状"
dws open --name scratch --file /tmp/brief.md             # 长提示词走文件
dws open --name scratch                                  # 只开任务，不发消息

dws list                     # 豆包窗口里的全部工作任务 + 本地记录的会话
dws projects                 # 侧边栏「项目」分组下的项目
dws use 38452760105511426    # 把窗口切到那条任务；status/info/send 也都认任务 id
dws archive <任务id|会话名>   # 整段对话存到 archives/ 并把侧边栏里的任务归档收起
dws stop <任务id|会话名>      # 中断正在跑的任务（双击 Esc；没在跑会如实说）
dws steer <任务id|会话名> "..."  # 跑动中追加指令（Command+Enter，不打断当前任务）
dws status                   # 全部会话的状态；也看单条：dws status win-ai-harness
dws status --json            # 给脚本用
dws info win-ai-harness      # 整段对话（含思考），--json 出结构化，--out 写文件
dws send win-ai-harness "接着改，先跑一下单测"   # 同一任务里续说
```

`dws help <命令>`（等价于 `dws <命令> --help`）只打印该命令的用法，不会执行。
公共参数 `-c <文件>` 与 `--config <文件>` 等价。

`status` / `info` 需要连上豆包窗口；窗口里不是这条会话的任务时，会明确告诉你
`不在当前窗口里（窗口里是另一个任务）`，并给出落盘的最后一次回复摘要。

## 配置

`config.json`（照 `config.example.json` 改），只剩会话相关的键：

| 键 | 说明 |
| --- | --- |
| `stateFile` | 本地会话记录放哪，默认 `.dws/state.json`；放 `~/.dws/config.json` 时写 `"state.json"`（否则会套成 `~/.dws/.dws/`） |
| `mode` | `local`（默认）/ `cloud` |
| `model` | `auto` 或具体模型 id |
| `pollSeconds` | 轮询回复的间隔 |
| `idleMinutes` | 回复停多久算卡死 |
| `timeoutMinutes` | 一条会话最多等多久 |

残留的工单/仓库/PR 字段（`repos`、`pickup`、`merge` 等）会被直接忽略，不会报错。

## 排障

| 现象 | 处理 |
| --- | --- |
| `豆包正在用你自己的 profile 运行` | ⌘Q 退出豆包，再跑 |
| `豆包没有登录` | 在 `dws` 起的那个窗口里登录一次（profile 会记住） |
| 会话说“菜单里没有模型” | 豆包模型菜单改了；`dws open --model auto` 或改 `models.json` |
| `dws status` 说不在当前窗口 | 窗口里是别的任务；`dws use <id>` 切过去再查 |

## 已知限制

- **UI 驱动，页面改版会坏**：按钮 `data-testid`、菜单结构一变就要跟着改 `src/doubao.mjs`。
- **单窗口串行**：豆包只有一个窗口，同一时刻只有一条任务在跑。
- **没有编排**：要「批量派活、跑完验收、发 PR」这类流程，得在外面自己组合 dws 和别的工具。
