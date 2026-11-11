# doubao-bot

一个仓库三个工具，各自一个文件夹，一个工具只管一件事：

| 命令 | 目录 | 管什么 |
| --- | --- | --- |
| `dws` | `dws/` | 豆包会话：开会话、发指令、看状态、取对话、续说、打断、归档 |
| `foreman` | `foreman/` | 接单编排：opencli 读工单 → herdr 开 worktree → dws 派活 → 验收 → push/开 PR |
| `opencli gitea` | `adapters/gitea/` | 内网 Gitea 读写（复用 Chrome 登录态） |

```
doubao-bot/
├── dws/                  # dws 包：bin/dws.mjs、src/、test/、README、package.json
├── foreman/              # foreman 包：bin/foreman.mjs、src/、test/、README、package.json
├── adapters/gitea/       # opencli 的 gitea 站点适配器源码（22 条命令）
├── skills/               # dws / foreman / gitea-opencli 三个技能
├── scripts/link-adapter.sh
└── package.json          # 只有 test / link:adapter 两个脚本，不放任何 CLI
```

三个工具互不代偿：dws 不碰工单和 PR，opencli 不碰豆包会话，herdr 只管 worktree，
串联只发生在 `foreman` 里。

## 挂载（都只有一份代码）

- **命令**：`dws`、`foreman` 各自 `npm link`，改源码立即生效
  （`cd dws && npm link`；`cd foreman && npm link`）。
- **技能**：`.user_skills/{dws,foreman,gitea-opencli}` 都是指向 `skills/*` 的软链。
- **gitea 适配器**：`~/.opencli/clis/gitea` 必须保持**真目录**（opencli 的发现逻辑
  只扫 `entry.isDirectory()`，目录整体软链会让整条 `gitea` 命令消失），里面的 `.js`
  逐个软链到 `adapters/gitea`。新增/删除适配器文件后跑一次：

```bash
bash scripts/link-adapter.sh    # 建文件软链 + 让适配器 import 能解析到全局 opencli 包
```

## 常用命令

```bash
# dws（豆包会话）
dws list / status <会话> / info <会话> / send <会话> "..." / open --name <名>
dws doctor

# foreman（接单编排）
foreman doctor
foreman run --dry-run --once
foreman run --once
foreman tasks / retry <仓库> <单号>

# opencli gitea
opencli gitea issue-view 255 --repo yyzl/win-ai-harness
opencli gitea label-list --repo yyzl/win-ai-harness

# 测试（两个包各跑一遍）
npm test
```

依赖：Node ≥ 22；`opencli`（Gitea，需 Chrome 登录态）；`herdr`（建 worktree）；
豆包桌面端（dws 要单实例，用户自己开着时先 ⌘Q）。
