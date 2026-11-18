# doubao-bot

一个仓库三个工具，各自一个文件夹，一个工具只管一件事：

| 命令 | 目录 | 管什么 |
| --- | --- | --- |
| `dws` | `dws/` | 豆包会话：开会话、发指令、看状态、取对话、续说、打断、归档 |
| `foreman` | `foreman/` | 接单编排：gitea 读工单 → herdr 开 worktree → dws 派活 → 验收 → push/开 PR |
| `gitea` | `gitea/` | 内网 Gitea 读写（REST API，令牌 `~/.foreman/gitea-token`） |

```
doubao-bot/
├── dws/                  # dws 包：bin/dws.mjs、src/、test/、README、package.json
├── foreman/              # foreman 包：bin/foreman.mjs、src/、test/、README、package.json
├── gitea/                # gitea 包：REST 客户端 + CLI（bin/gitea.mjs，23 条命令）
├── adapters/gitea/       # 【历史】旧 opencli 浏览器适配器，已不参与发布
├── skills/               # dws / foreman / gitea 三个技能
└── package.json          # 只有 test / link:adapter 两个脚本，不放任何 CLI
```

技能与链路的对应：`dws` 只管会话、`gitea` 只管工单读写、`foreman` 管串联（选单→worktree→派活→验收→PR→通知调用方）。

三个工具互不代偿：dws 不碰工单和 PR，gitea 不碰豆包会话，herdr 只管 worktree，
串联只发生在 `foreman` 里。

## 挂载（源码只读，线上跑 dist）

可上线的东西都先发布到 `dist/`，链接指向 dist 而不是源码——开发时改源码不会立刻影响
线上命令，要上线就 commit 后跑一次发布。工作区有未提交改动的单元默认跳过。

```bash
scripts/publish.sh                 # 全部：bin（dws/foreman）+ skill + gitea 适配器
scripts/publish.sh dws             # 只发某个单元：gitea / foreman / dws / skills
scripts/publish.sh --allow-dirty   # 有未提交改动也照发（默认跳过脏单元）
```

- **命令**：`dws`、`foreman` 由 `npm link` 装到全局，指向 `dist/dws`、`dist/foreman`。
- **技能**：`~/Doubao/skills/{dws,foreman,gitea}` 软链到 `dist/skills/*`。**只有这一处**——
  别再往工作区 `.user_skills/` 复制同一技能：两个目录都会被扫描，同一技能会出现两张卡片，
  名字大小写还不一致（踩过一次：`.user_skills/dws` + `~/Doubao/skills/dws` 同时在，面板出现 `Dws` 和 `dws`）。
- **gitea 命令**：`gitea/` 由 `npm link` 装成全局 `gitea`（指向 `dist/gitea`）；foreman 发布时
  会一并发布它，因为 `foreman/src/gitea.mjs` 直接 import `../../gitea/src/api.mjs`。
  旧的 `~/.opencli/clis/gitea` 浏览器适配器已停用，可以删掉。
- **令牌**：`~/.foreman/gitea-token`（chmod 600），或 `GITEA_TOKEN` 环境变量；生成入口是
  Gitea「设置 → 应用 → 管理 Access Token」，scopes 至少 issue / repository / organization 读写。

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

# gitea（REST）
gitea issue-view 255 --repo yyzl/win-ai-harness
gitea label-list --repo yyzl/win-ai-harness

# 测试（两个包各跑一遍）
npm test
```

依赖：Node ≥ 22；`gitea`（REST，需令牌）；`herdr`（建 worktree）；
豆包桌面端（dws 要单实例，用户自己开着时先 ⌘Q）。
