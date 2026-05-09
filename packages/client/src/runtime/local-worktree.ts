import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/**
 * "Local-direct" mode for a Hub-managed git repo binding (Plan A — see
 * `docs/new-user-onboarding-design.md`):
 *
 *   - the user already has a working clone at some absolute path on the
 *     client host (the `localPath` field of `gitRepos[]` is absolute, e.g.
 *     `/Users/me/code/repo` or `~/code/repo`);
 *   - we materialise a per-session worktree at `<workspace>/<displayName>/`
 *     by running `git worktree add` inside that user clone — agent's
 *     `<workspace>/<displayName>/` mirrors the sandbox layout, but the
 *     branch is committed to the user's actual repo, not a Hub bare mirror.
 *
 * Cleanup keeps the branch around (the user reviews it) and only removes
 * the worktree directory + git's internal worktree registration.
 */

export type LocalWorktreeAddArgs = {
  /** Absolute or `~`-prefixed path to the user's existing clone. */
  repoRoot: string;
  /** Where to materialise the worktree (already inside the agent workspace). */
  targetPath: string;
  /** Branch name to create / reset. Caller supplies a session-derived name. */
  branchName: string;
  /** Optional ref to base the branch on. Defaults to `HEAD` of the user's clone. */
  ref?: string;
  /** Per-session log sink (forwarded to chat). */
  log?: (msg: string) => void;
};

export type LocalWorktreeOwned = {
  repoRoot: string;
  path: string;
  branchName: string;
};

/**
 * `path.isAbsolute` recognises POSIX `/foo` and Windows `C:\foo`. We also want
 * `~` and `~/foo` to count as absolute for product purposes — operators
 * commonly type that. Relative paths like `repo-name` continue to mean
 * "subdirectory of the session workspace" (the legacy semantic).
 */
export function isAbsoluteLocalPath(p: string): boolean {
  if (!p) return false;
  if (p === "~" || p.startsWith("~/")) return true;
  return isAbsolute(p);
}

/** Expand a leading `~` to the host's home directory. No-op otherwise. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Add a session-scoped worktree on a fresh branch inside the user's clone.
 * Idempotent on resume: if `<targetPath>/.git` already exists we assume the
 * worktree from a prior bind is still good and skip the `git worktree add`.
 */
export async function addLocalWorktree(args: LocalWorktreeAddArgs): Promise<LocalWorktreeOwned> {
  const repoRoot = expandHome(args.repoRoot);
  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(`Local repo path "${args.repoRoot}" is not a git repository (no .git/).`);
  }

  if (existsSync(join(args.targetPath, ".git"))) {
    args.log?.(`Git: reusing existing local worktree at ${args.targetPath}`);
    return { repoRoot, path: args.targetPath, branchName: args.branchName };
  }

  const argv = ["-C", repoRoot, "worktree", "add", "-B", args.branchName, args.targetPath, args.ref ?? "HEAD"];
  await runGit(argv, DEFAULT_GIT_TIMEOUT_MS);
  args.log?.(`Git: local worktree at ${args.targetPath} on ${args.branchName} (from ${repoRoot})`);
  return { repoRoot, path: args.targetPath, branchName: args.branchName };
}

/**
 * Remove a worktree we previously added. Branch is left intact intentionally —
 * the user reviews + merges or deletes via their normal git workflow. `--force`
 * because we may have agent-modified files we don't want to argue about.
 */
export async function removeLocalWorktree(owned: LocalWorktreeOwned, log?: (msg: string) => void): Promise<void> {
  const argv = ["-C", owned.repoRoot, "worktree", "remove", "--force", owned.path];
  try {
    await runGit(argv, DEFAULT_GIT_TIMEOUT_MS);
    log?.(`Git: removed local worktree at ${owned.path} (branch ${owned.branchName} preserved)`);
  } catch (err) {
    log?.(`Git: worktree remove failed at ${owned.path} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runGit(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr.slice(0, 1024)}`));
    });
  });
}
