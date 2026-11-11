// git + herdr：每个工单在自己的 worktree 里做，不碰用户正在用的那份工作区。
// worktree 由 herdr 创建（它同时会在 herdr 里开一个工作区）；herdr 不可用或失败时
// 才退回原生 `git worktree add`，并且把原因写进日志。
import fs from "node:fs"
import path from "node:path"
import { exec, expandHome } from "./util.mjs"

export class GitError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, { code: "git_error" }, extra)
  }
}

export async function git(args, { cwd, timeout = 60000 } = {}) {
  try {
    return await exec("git", args, { cwd, timeout })
  } catch (e) {
    throw new GitError(e.message, { args, cwd })
  }
}

export async function fetchBase(repoDir, base) {
  return git(["fetch", "origin", base, "--quiet"], { cwd: repoDir, timeout: 120000 })
}

export async function branchExists(repoDir, branch) {
  try {
    await git(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoDir })
    return true
  } catch {
    return false
  }
}

// createWorktree：已有就复用（上次没做完的），没有就让 herdr 从 origin/<base> 开。
export async function createWorktree({
  repoDir,
  worktreeDir,
  branch,
  base,
  herdrBin = "herdr",
  useHerdr = true,
  log = () => {},
}) {
  repoDir = expandHome(repoDir)
  worktreeDir = expandHome(worktreeDir)
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new GitError(`不是 git 仓库：${repoDir}`)
  }
  const wt = path.join(worktreeDir, branch.replace(/\//g, "-"))
  if (fs.existsSync(path.join(wt, ".git"))) {
    return { path: wt, reused: true, branch, backend: "existing" }
  }
  if (fs.existsSync(wt)) throw new GitError(`目录已存在但不是 git worktree：${wt}`)
  fs.mkdirSync(worktreeDir, { recursive: true })
  await fetchBase(repoDir, base)

  if (useHerdr) {
    try {
      await exec(
        herdrBin,
        [
          "worktree",
          "create",
          "--cwd",
          repoDir,
          "--branch",
          branch,
          "--base",
          `origin/${base}`,
          "--path",
          wt,
          "--no-focus",
          "--trust-repository",
        ],
        { timeout: 180000 }
      )
      return { path: wt, reused: false, branch, backend: "herdr" }
    } catch (e) {
      log(`herdr 建工作区失败，退回 git worktree add：${String(e.message).slice(0, 300)}`)
    }
  }

  if (await branchExists(repoDir, branch)) {
    await git(["worktree", "add", wt, branch], { cwd: repoDir, timeout: 120000 })
  } else {
    await git(["worktree", "add", "-B", branch, wt, `origin/${base}`], { cwd: repoDir, timeout: 120000 })
  }
  return { path: wt, reused: false, branch, backend: "git" }
}

export async function worktreeRemove(repoDir, wt) {
  try {
    await git(["worktree", "remove", "--force", wt], { cwd: expandHome(repoDir), timeout: 60000 })
    return true
  } catch {
    return false
  }
}

export async function statusPorcelain(wt) {
  const r = await git(["status", "--porcelain"], { cwd: wt })
  return r.stdout.trim()
}

export async function commitsAhead(wt, base) {
  const r = await git(["rev-list", "--count", `origin/${base}..HEAD`], { cwd: wt })
  return Number(r.stdout.trim()) || 0
}

export async function diffStat(wt, base) {
  const r = await git(["diff", "--stat", `origin/${base}...HEAD`], { cwd: wt })
  return r.stdout.trim()
}

export async function currentBranch(wt) {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt })
  return r.stdout.trim()
}

export async function pushBranch(wt, branch) {
  return git(["push", "-u", "origin", `${branch}:${branch}`], { cwd: wt, timeout: 180000 })
}

export async function recentCommits(wt, base, n = 10) {
  const r = await git(["log", "--format=%h %s", `origin/${base}..HEAD`, `-n`, String(n)], { cwd: wt })
  return r.stdout.trim()
}
