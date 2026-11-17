# dws 排障

目录
1. 先跑这两条
2. 豆包侧（app_busy / 登录 / 窗口 / 模型菜单）
3. 会话与本地状态
4. 已知限制（不是 bug）

## 1. 先跑这两条

```bash
command -v dws && dws --help
dws doctor                 # 零成本：二进制、profile、配置、进程/CDP 端口
dws start                  # 要拉起豆包查登录态与窗口用这个（doctor --start 已下线）
```

`doctor` 打 JSON，`ok:false` 的条目就是问题所在；不要跳过它去猜。默认 profile 与二进制：

- profile：`~/Library/Application Support/magpie-doubao-work`（豆包工作 app 用其下 `doubaowork/`）；换用 `DOUBAO_WORK_HOME`
- 二进制：`/Applications/DoubaoWork.app/...` 优先，其次 `/Applications/Doubao.app/...`；换用 `DOUBAO_WORK_APP`
- 模型表：`<profile>/models.json`

## 2. 豆包侧（app_busy / 登录 / 窗口 / 模型菜单）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `app_busy` /「豆包已经在运行（PID …），但没有可用的 CDP 调试端口」 | 豆包在跑但没开调试端口（通常是用户自己开的那个窗口占了单实例）；不是配置错 | 要独占启动就 `dws start --force`（先杀掉豆包进程再起，用户自己的窗口会没）；或让用户 ⌘Q 退出后重跑 `dws start`。**不要换 profile、不要反复重试**；起来后 `dws start` 查登录 |
| 从豆包会话里跑 `dws start --force` 被拒 | 杀豆包会把发出命令的这个会话窗口一起杀掉 | 不是 bug：到终端里跑 `dws start --force` |
| `doubao_signed_out` /「豆包没有登录」 | 该 profile 没登录态 | 在 dws 起的那个窗口里登录一次，profile 会记住 |
| `app_missing` | 两个 app 路径都没有，`DOUBAO_WORK_APP` 也指错 | 装豆包/豆包工作，或用 `DOUBAO_WORK_APP` 指到真实二进制 |
| `app_start_timeout` | 启动慢或被杀 | 重试一次；仍失败看是否有安全软件拦启动 |
| `doubao_no_window` | 起来了但没有聊天页 | 确认没被登录页/更新弹窗挡住；`dws start` 复跑 |
| 会话说「菜单里没有模型」 | 豆包模型菜单改版，`models.json` 里的入口对不上 | 先用 `--model auto`；仍不行更新 `<profile>/models.json`（结构在 `src/doubao.mjs`） |
| 按钮点了没反应 / 找不到输入框 | 页面改版，`data-testid` 变了 | 改 `src/doubao.mjs` 里的选择器；这是 UI 驱动的已知代价 |
| `status` 报「不在当前窗口里（窗口里是另一个任务）」 | 单窗口，当前只挂着别的任务 | 正常现象：`dws use <任务id>` 切过去，或直接看落盘的 `replySummary`；`send` 会自动新开任务并带 handoff |
| 调 `dws run` / `retry` / `tasks` 报「未知命令」 | 这三条已从 dws 删掉（dws 只管会话） | 不是坏了；要编排请在外部组合别的工具 |

## 3. 会话与本地状态

```bash
dws list                    # 窗口里的工作任务 + 本地记录的会话
dws status --json           # 每条会话的状态
```

- `state.json` 里 `sessions` 条数多但窗口里没那么多任务：归档/历史残留，正常。
- 找不到某条会话：`dws list` 看它是不是被归档了，或用任务 id 直接查（`dws status <id>`）。
- `info` 输出很长：一定用 `--out` 落盘再读，别直接怼在终端里。
- 本地状态出问题（JSON 坏了、记错会话）：先 `cp <stateFile> <stateFile>.bak` 备份再改。

## 4. 已知限制（不是 bug）

- **UI 驱动**：豆包页面改版会坏选择器，坏点在 `src/doubao.mjs`。
- **单窗口串行**：同一时刻只有一条任务在跑；换任务会新开一条侧边栏任务。
- **不做编排**：批量派活、验收、提 PR 这类流程不归 dws，得在外面组合。
- **会话里的模型自己跑命令**：`mode: local` 才能访问内网与本地仓库。
