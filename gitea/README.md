# gitea（REST CLI）

内网 Gitea 的 REST API 客户端与命令行，替代原来的 opencli 浏览器自动化。
foreman 直接 import `src/api.mjs`，CLI 只是同一份实现的薄壳，命令名与参数保持旧版 23 条不变。

```bash
node gitea/bin/gitea.mjs issue-view 353 --repo yyzl/win-ai-harness
node gitea/bin/gitea.mjs search "" --repo yyzl/win-ai-harness --state open --label 5
```

## 令牌与站点

优先级：

- 令牌：`GITEA_TOKEN` → `GITEA_TOKEN_FILE` → `~/.foreman/config.json` 的 `gitea.tokenFile`
  → `~/.foreman/gitea-token` → `~/.config/gitea/token` → config `gitea.token`
- 站点：`GITEA_BASE_URL` → config `gitea.baseUrl` → `http://106.54.199.229:3000`

生成令牌：Gitea「设置 → 应用 → 管理 Access Token」，scopes 至少 issue / repository /
organization 的读写；明文只显示一次，写入 `~/.foreman/gitea-token` 后 `chmod 600`。

401 统一归一为 `auth_required`，提示重新生成；报错信息里不会出现令牌。

## 语义约定

- 输出 `{ok:true,data}` / `{ok:false,error:{code,message,status?}}`，退出码 1 表示失败。
- `empty_result` = 已经是目标状态（重复关闭、重复合并、重复指派），不是故障。
- 列表只回收敛字段（不含正文）；`issue-view` / `pr-view` 才回正文与评论。
- 标签：`search --label` 收 id（内部翻名字 + 按 id 精确过滤）；建单/改单收名字或 id；
  组织级标签（`needs-triage` 等）并入 `label-list`。
- 里程碑名字可能是纯数字，解析时先按 id 再按名字。
- PR `mergeNote` 由 REST 字段合成（已合并 / 已关闭 / 分支已包含 / 不可自动合并），
  供 `prwatch` 判冲突。

## OpenCLI gitea 补充（只列 REST 做不到的）

`opencli gitea` 适配器已从 git 恢复，与上面的 CLI 命令名、参数、实现完全一致（同一份
`src/api.mjs`），所以只有下面两类情况才值得走它，其余命令不要两边重复执行：

1. **令牌不可用 / 失效**：`opencli gitea <同名命令>` 复用 Chrome 登录态，当备用通道；
   发布入口是 `node scripts/publish.mjs adapters`，装到 `~/.opencli/clis/gitea`（POSIX 文件软链，Windows 复制）。
2. **关闭操作人 / 合并操作人 / 仓库 activity 动态**：REST 实体里没有 `closer`、`merged_by`、
   `activity` 字段，`issue-view` / `pr-view` 也取不到；只能页面取证：
   `opencli browser open <页面>` 后 `opencli browser eval` 取数。

## 测试

```bash
npm --prefix gitea test          # 纯单测，假 fetch，不出网
```

真实实例自检（需要令牌）：

```bash
node gitea/bin/gitea.mjs label-list --repo yyzl/win-ai-harness
node gitea/bin/gitea.mjs pr-view 357 --repo yyzl/win-ai-harness
```
