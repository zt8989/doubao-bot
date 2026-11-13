// 工作会话只负责「改完就 commit」：push 分支、开 PR 都由 foreman 补。
// 这样工作会话完全不需要知道 foreman 的存在（它只读工单、改工作区、提交、结束），
// PR 编号与链接由 foreman 记进账本，编排会话读到 PR 再决定合不合。
import { Book } from "./book.mjs"
import { prBody } from "./prompts.mjs"
import { commitsAhead, diffStat, pushBranch, recentCommits, statusPorcelain } from "./gitx.mjs"
import { upsertPr } from "./workspaces.mjs"
import * as realGitea from "./gitea.mjs"

// 一工程一条 PR：逐个工作区检查（干净、有提交）→ push → 建 PR → 记账。
// 返回 { ok, prs:[{repo,branch,pr,prUrl}], notes:[没开成的原因] }，幂等靠账本 prs[] 判重。
export async function openPrsForIssue(ctx, { issueKey, summary = "", tests = "" } = {}) {
  const { cfg, log = () => {} } = ctx
  const gitea = ctx.gitea ?? realGitea
  const git = ctx.git ?? { commitsAhead, diffStat, pushBranch, recentCommits, statusPorcelain }
  const book = new Book(cfg.stateFile)
  const key = String(issueKey ?? "").trim()
  const rec = book.issue(key)
  if (!rec) return { ok: false, reason: "unknown-issue", prs: [], notes: [] }

  const issueRepo = String(key).split("#")[0]
  const issueNo = Number(String(key).split("#")[1] ?? 0)
  const title = String(rec.title ?? "")
  const wsList = Array.isArray(rec.workspaces) && rec.workspaces.length
    ? rec.workspaces
    : rec.worktree
      ? [{ repo: rec.repo || issueRepo, branch: rec.branch ?? "", worktree: rec.worktree }]
      : []

  const prs = []
  const notes = []
  for (const ws of wsList) {
    const repoCfg = (cfg.repos ?? []).find((r) => r.repo === ws.repo)
    const wt = String(ws.worktree ?? "").trim()
    const branch = String(ws.branch ?? "").trim()
    if (!repoCfg?.dir || !wt || !branch) {
      notes.push(`${ws.repo || "?"}：账本里没有工作区或分支，跳过`)
      continue
    }
    try {
      const dirty = await git.statusPorcelain(wt)
      if (dirty) {
        notes.push(`${ws.repo}：工作区还有未提交改动（会话没 commit），先不开 PR`)
        continue
      }
      const ahead = await git.commitsAhead(wt, repoCfg.base)
      if (!ahead) {
        notes.push(`${ws.repo}：分支上没有新提交（origin/${repoCfg.base}..HEAD = 0），先不开 PR`)
        continue
      }
      const commits = await git.recentCommits(wt, repoCfg.base)
      const stat = await git.diffStat(wt, repoCfg.base)
      await git.pushBranch(wt, branch)
      log(`${key}：已 push ${ws.repo} ${branch}（foreman 代工作会话推）`)
      const pr = await gitea.createPr({
        repo: ws.repo,
        base: repoCfg.base,
        head: branch,
        title: `fix(#${issueNo}): ${title}`,
        body: prBody({ issue: { number: issueNo, title }, summary, tests, commits, stat, base: repoCfg.base }),
      })
      const number = Number(pr?.number ?? 0)
      if (!number) {
        notes.push(`${ws.repo}：PR 建了但拿不到编号（${pr?.url ?? ""}）`)
        continue
      }
      prs.push({ repo: ws.repo, branch, pr: number, prUrl: pr.url ?? "" })
      log(`${key}：PR ${ws.repo}#${number} 已开（${pr.url ?? ""}）`)
    } catch (e) {
      notes.push(`${ws.repo}：push / 开 PR 失败：${String(e?.message ?? e).slice(0, 160)}`)
    }
  }

  if (prs.length) {
    const b = new Book(cfg.stateFile)
    const prev = b.issue(key) ?? {}
    let list = Array.isArray(prev.prs) ? prev.prs : []
    for (const p of prs) list = upsertPr(list, p)
    const primary = prs.find((p) => p.repo === issueRepo) ?? prs[0]
    const patch = { state: "pr-open", prs: list, openedAt: new Date().toISOString() }
    if (primary && (primary.repo === issueRepo || !Number(prev.pr ?? 0))) {
      patch.pr = primary.pr
      patch.prUrl = primary.prUrl
      patch.branch = primary.branch
    }
    b.setIssue(key, patch)
    for (const p of prs) {
      b.markPrSeen(`${p.repo}#${p.pr}`, {
        repo: p.repo,
        number: p.pr,
        title: `fix(#${issueNo}): ${title}`,
        url: p.prUrl,
        author: cfg.pickup?.me ?? "",
        skipped: "self",
      })
      try {
        ctx.consoleStore?.event({
          kind: "pr_open",
          key: `${p.repo}#${p.pr}`,
          repo: p.repo,
          number: p.pr,
          to: "open",
          detail: `${repoCfgBase(cfg, p.repo)} ← ${p.branch} · 工单 ${key}`,
        })
      } catch {}
    }
    try {
      ctx.consoleStore?.sync(new Book(cfg.stateFile))
    } catch {}
  }

  return { ok: prs.length > 0, issueKey: key, prs, notes }
}

function repoCfgBase(cfg, repo) {
  return String((cfg.repos ?? []).find((r) => r.repo === repo)?.base ?? "")
}
