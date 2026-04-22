import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { pino } from "../observability/logger.js";

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const SESSION_BRANCH_PREFIX = "hub-session";

/**
 * Per-URL bare mirror manager.
 *
 * Layout:
 *   <dataDir>/git-mirrors/<sha256(url)>/  ← bare repo (shared object store)
 *
 * Isolation model:
 * - The mirror is configured with `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*`
 *   and `remote.origin.mirror` unset. `git fetch` therefore writes only to
 *   `refs/remotes/origin/*` and never touches `refs/heads/*`.
 * - Each session owns a dedicated local branch `hub-session-<sessionHash>-<urlHash>`
 *   in the mirror. Worktrees attach to that branch, not to a remote-tracking ref,
 *   so two sessions on the same URL get disjoint branch names and cannot
 *   collide on `git worktree add` or on `git fetch` ref locks.
 *
 * Authentication is delegated to the host Git environment — no env vars or
 * credential helpers are injected.
 */
export type GitMirrorManagerOptions = {
  dataDir: string;
  cloneTimeoutMs?: number;
  log?: pino.Logger;
};

export interface GitMirrorManager {
  ensureMirror(url: string): Promise<{ mirrorPath: string; elapsedMs: number; cloned: boolean }>;
  fetchMirror(url: string): Promise<{ elapsedMs: number }>;
  createWorktree(args: {
    url: string;
    ref?: string;
    targetPath: string;
    sessionKey: string;
  }): Promise<{ worktreePath: string; headCommit: string; branchName: string }>;
  removeWorktree(args: { url: string; path: string; branchName: string }): Promise<void>;
  gcMirrors(stillReferencedUrls: Set<string>): Promise<{ removed: string[] }>;
  readonly mirrorsRoot: string;
}

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export function deriveSessionBranchName(sessionKey: string, url: string): string {
  return `${SESSION_BRANCH_PREFIX}-${shortHash(sessionKey)}-${shortHash(url)}`;
}

/**
 * A value is SHA-like when it's a 7–40 character hex string. Used to decide
 * whether `ref` should be resolved via the remote namespace (branch name) or
 * used as-is (commit hash).
 */
function looksLikeCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

export function createGitMirrorManager(opts: GitMirrorManagerOptions): GitMirrorManager {
  const mirrorsRoot = join(opts.dataDir, "git-mirrors");
  const cloneTimeoutMs =
    opts.cloneTimeoutMs ?? Number(process.env.FIRST_TREE_HUB_GIT_CLONE_TIMEOUT_MS ?? DEFAULT_CLONE_TIMEOUT_MS);
  const log = opts.log;

  // Per-URL serial queue. Prevents concurrent ensureMirror / fetchMirror /
  // gcMirrors for the same URL from racing on the same directory.
  const urlLocks = new Map<string, Promise<unknown>>();

  function withUrlLock<T>(url: string, op: () => Promise<T>): Promise<T> {
    const key = hashUrl(url);
    const prev = urlLocks.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    urlLocks.set(key, next);
    // Drop the map entry once the tail resolves so a long-lived manager doesn't
    // leak one entry per URL forever. Silently swallow errors on this side
    // channel — the real rejection is delivered via the returned `next`.
    next.then(
      () => {
        if (urlLocks.get(key) === next) urlLocks.delete(key);
      },
      () => {
        if (urlLocks.get(key) === next) urlLocks.delete(key);
      },
    );
    return next;
  }

  function mirrorDir(url: string): string {
    return join(mirrorsRoot, hashUrl(url));
  }

  async function git(args: string[], cwd: string | null, timeoutMs: number, env?: NodeJS.ProcessEnv) {
    const start = Date.now();
    return await new Promise<{ stdout: string; stderr: string; elapsedMs: number }>((resolveExec, rejectExec) => {
      const proc = spawn("git", args, {
        cwd: cwd ?? undefined,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        rejectExec(new GitMirrorTimeoutError(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on("error", (err) => {
        clearTimeout(timer);
        rejectExec(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - start;
        if (code === 0) resolveExec({ stdout, stderr, elapsedMs });
        else rejectExec(new GitMirrorError(`git ${args.join(" ")} exited with code ${code}: ${stderr.slice(0, 1024)}`));
      });
    });
  }

  async function gitOk(args: string[], cwd: string, timeoutMs: number): Promise<boolean> {
    try {
      await git(args, cwd, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the mirror's config to the invariant expected by this module:
   * fetch refspec = `+refs/heads/*:refs/remotes/origin/*`, `remote.origin.mirror`
   * absent, `refs/remotes/origin/HEAD` resolvable.
   *
   * Called from `ensureMirror` on every invocation — both the fresh-clone path
   * (ensures our own bootstrap wrote the right values) and the pre-existing
   * mirror path (repairs drift from the legacy `--mirror` config).
   */
  async function assertMirrorConfig(mirrorPath: string, url: string): Promise<{ migrated: boolean }> {
    let migrated = false;

    // Read current fetch spec. `--get-all` returns every value on its own line;
    // empty stdout means the key is absent.
    let currentFetch = "";
    try {
      const { stdout } = await git(["config", "--get-all", "remote.origin.fetch"], mirrorPath, 10_000);
      currentFetch = stdout.trim();
    } catch {
      currentFetch = "";
    }

    if (currentFetch !== FETCH_REFSPEC) {
      // Replace whatever is there with exactly our refspec.
      await git(["config", "--replace-all", "remote.origin.fetch", FETCH_REFSPEC], mirrorPath, 10_000);
      migrated = true;
    }

    // `mirror = true` forces every fetch to prune & force-update every ref —
    // must be unset for our refspec to behave as intended.
    const mirrorFlag = await gitOk(["config", "--get", "remote.origin.mirror"], mirrorPath, 10_000);
    if (mirrorFlag) {
      await git(["config", "--unset-all", "remote.origin.mirror"], mirrorPath, 10_000);
      migrated = true;
    }

    // Ensure origin URL matches (a mismatched URL would make migration silently
    // pick up from the wrong upstream — refuse).
    try {
      const { stdout } = await git(["config", "--get", "remote.origin.url"], mirrorPath, 10_000);
      const currentUrl = stdout.trim();
      if (currentUrl !== url) {
        await git(["config", "--replace-all", "remote.origin.url", url], mirrorPath, 10_000);
        migrated = true;
      }
    } catch {
      await git(["remote", "add", "origin", url], mirrorPath, 10_000);
      migrated = true;
    }

    if (migrated) {
      // Populate `refs/remotes/origin/*` and set `origin/HEAD`. Without this,
      // newly-migrated mirrors have no remote-tracking refs to base worktrees on.
      await git(["fetch", "--prune", "origin"], mirrorPath, cloneTimeoutMs);
      // Failing `set-head --auto` is non-fatal — callers that pass an explicit
      // `ref` don't need origin/HEAD, and fallbacks below handle its absence.
      await gitOk(["remote", "set-head", "origin", "--auto"], mirrorPath, 30_000);
      log?.info({ gitUrl: url }, "mirror config migrated");
    }

    return { migrated };
  }

  /**
   * Bootstrap a fresh mirror at `mirrorPath`. Uses `git init --bare` +
   * manual remote setup rather than `git clone --mirror` / `git clone --bare`,
   * so we never transiently have the mirror configured to force-write
   * `refs/heads/*` on fetch.
   */
  async function bootstrapMirror(mirrorPath: string, url: string): Promise<void> {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    await git(["init", "--bare", mirrorPath], null, cloneTimeoutMs);
    await git(["remote", "add", "origin", url], mirrorPath, 10_000);
    await git(["config", "--replace-all", "remote.origin.fetch", FETCH_REFSPEC], mirrorPath, 10_000);
    await git(["fetch", "--prune", "origin"], mirrorPath, cloneTimeoutMs);
    await gitOk(["remote", "set-head", "origin", "--auto"], mirrorPath, 30_000);
  }

  async function branchExists(mirrorPath: string, branchName: string): Promise<boolean> {
    return await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], mirrorPath, 10_000);
  }

  /**
   * Resolve the commit-ish to base a new session branch on.
   *
   * - explicit SHA → use as-is
   * - explicit branch name → prefer `refs/remotes/origin/<ref>`, fall back to
   *   a literal SHA resolution in case the caller handed us a short commit
   * - `ref` absent → `refs/remotes/origin/HEAD`
   */
  async function resolveBase(mirrorPath: string, ref: string | undefined): Promise<string> {
    if (!ref) {
      if (await gitOk(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"], mirrorPath, 10_000)) {
        return "refs/remotes/origin/HEAD";
      }
      throw new GitMirrorError(
        "Cannot resolve default branch: refs/remotes/origin/HEAD is missing. Re-run with an explicit `ref`.",
      );
    }
    if (looksLikeCommitSha(ref)) {
      if (await gitOk(["cat-file", "-e", ref], mirrorPath, 10_000)) return ref;
    }
    const remoteRef = `refs/remotes/origin/${ref}`;
    if (await gitOk(["rev-parse", "--verify", "--quiet", remoteRef], mirrorPath, 10_000)) {
      return remoteRef;
    }
    // Last resort: let git resolve `ref` against whatever it can find (tags,
    // local heads, etc.). If this fails the error surfaces to the caller.
    return ref;
  }

  return {
    get mirrorsRoot() {
      return mirrorsRoot;
    },

    ensureMirror(url) {
      return withUrlLock(url, async () => {
        mkdirSync(mirrorsRoot, { recursive: true });
        const path = mirrorDir(url);
        if (existsSync(join(path, "HEAD"))) {
          const { migrated } = await assertMirrorConfig(path, url);
          if (migrated) {
            // migration fetched already; report elapsed as 0 to preserve the
            // existing "cloned === false => fast path" contract.
          }
          return { mirrorPath: path, elapsedMs: 0, cloned: false };
        }
        const start = Date.now();
        try {
          await bootstrapMirror(path, url);
          const elapsedMs = Date.now() - start;
          log?.debug({ gitUrl: url, elapsedMs, cloned: true }, "mirror ensured");
          return { mirrorPath: path, elapsedMs, cloned: true };
        } catch (err) {
          if (err instanceof GitMirrorTimeoutError) {
            log?.warn({ gitUrl: url, timeoutMs: cloneTimeoutMs, elapsedMs: cloneTimeoutMs }, "mirror clone timeout");
          }
          if (existsSync(path)) rmSync(path, { recursive: true, force: true });
          throw err;
        }
      });
    },

    fetchMirror(url) {
      return withUrlLock(url, async () => {
        const path = mirrorDir(url);
        if (!existsSync(join(path, "HEAD"))) {
          throw new GitMirrorError(`Cannot fetch — no mirror exists for "${url}"`);
        }
        try {
          const { elapsedMs } = await git(["fetch", "--prune", "origin"], path, cloneTimeoutMs);
          return { elapsedMs };
        } catch (err) {
          log?.warn(
            {
              gitUrl: url,
              errorCode: err instanceof GitMirrorError ? "git-failed" : "unknown",
              stderr: err instanceof Error ? err.message.slice(0, 1024) : String(err).slice(0, 1024),
            },
            "mirror fetch failed",
          );
          throw err;
        }
      });
    },

    createWorktree({ url, ref, targetPath, sessionKey }) {
      return withUrlLock(url, async () => {
        const mirror = mirrorDir(url);
        if (!existsSync(join(mirror, "HEAD"))) {
          throw new GitMirrorError(`Cannot create worktree — no mirror exists for "${url}"`);
        }
        const absTarget = resolve(targetPath);
        const branchName = deriveSessionBranchName(sessionKey, url);

        // D13: target path must be free OR a Hub-managed worktree we can reuse.
        if (existsSync(absTarget) && !isHubManagedWorktree(absTarget)) {
          log?.warn(
            {
              gitUrl: url,
              targetPath: absTarget,
              occupantKind: classifyOccupant(absTarget),
            },
            "worktree create conflict",
          );
          throw new GitMirrorWorktreeConflictError(
            `Worktree target "${absTarget}" is already occupied by ${classifyOccupant(absTarget)} — aborting (D13)`,
          );
        }

        const pathExists = existsSync(absTarget);
        const hasBranch = await branchExists(mirror, branchName);

        mkdirSync(dirname(absTarget), { recursive: true });

        // Crash-recovery matrix (see refactor plan §5.3):
        //   path + branch    → reuse (short-circuit here even though callers also
        //                       short-circuit; defensive, cheap)
        //   !path + !branch  → `worktree add -b <branch> <path> <base>`
        //   !path + branch   → `worktree add <path> <branch>` (attach existing)
        //   path + !branch   → corruption; refuse rather than guess
        if (pathExists && hasBranch) {
          // Already wired up — treat as successful reuse.
        } else if (pathExists && !hasBranch) {
          throw new GitMirrorError(
            `Worktree directory "${absTarget}" exists as a Hub worktree but the expected session branch "${branchName}" is missing in the mirror — manual cleanup required`,
          );
        } else if (!pathExists && hasBranch) {
          await git(["worktree", "add", absTarget, branchName], mirror, cloneTimeoutMs);
        } else {
          const base = await resolveBase(mirror, ref);
          await git(["worktree", "add", "-b", branchName, absTarget, base], mirror, cloneTimeoutMs);
        }

        const head = await git(["rev-parse", "HEAD"], absTarget, 30_000);
        return { worktreePath: absTarget, headCommit: head.stdout.trim(), branchName };
      });
    },

    removeWorktree({ url, path, branchName }) {
      return withUrlLock(url, async () => {
        const absTarget = resolve(path);
        const mirror = mirrorDir(url);
        if (!isBareRepo(mirror)) {
          // Mirror was already GC'd; just rm the orphan dir if it exists.
          if (existsSync(absTarget)) rmSync(absTarget, { recursive: true, force: true });
          return;
        }
        if (existsSync(absTarget)) {
          await gitOk(["worktree", "remove", "--force", absTarget], mirror, 30_000);
        } else {
          // Path is already gone — let git prune its bookkeeping so later
          // worktree-add calls don't hit the stale admin record.
          await gitOk(["worktree", "prune"], mirror, 30_000);
        }
        if (existsSync(absTarget)) {
          // Worktree wasn't git-registered (orphan dir) — rm for tidiness.
          rmSync(absTarget, { recursive: true, force: true });
        }
        if (await branchExists(mirror, branchName)) {
          await gitOk(["branch", "-D", branchName], mirror, 10_000);
        }
      });
    },

    async gcMirrors(stillReferencedUrls) {
      if (!existsSync(mirrorsRoot)) return { removed: [] };
      const wantedHashes = new Set([...stillReferencedUrls].map(hashUrl));
      const removed: string[] = [];
      for (const entry of readdirSync(mirrorsRoot)) {
        if (wantedHashes.has(entry)) continue;
        const path = join(mirrorsRoot, entry);
        if (!isBareRepo(path)) continue;
        rmSync(path, { recursive: true, force: true });
        removed.push(entry);
      }
      return { removed };
    },
  };
}

function isBareRepo(p: string): boolean {
  return existsSync(join(p, "HEAD")) && existsSync(join(p, "objects"));
}

function isHubManagedWorktree(p: string): boolean {
  const gitMarker = join(p, ".git");
  if (!existsSync(gitMarker)) return false;
  try {
    return statSync(gitMarker).isFile();
  } catch {
    return false;
  }
}

function classifyOccupant(p: string): string {
  try {
    const stat = statSync(p);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) {
      if (existsSync(join(p, ".git"))) return "git-repo";
      return "directory";
    }
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return "unknown";
  }
}

export class GitMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorError";
  }
}

export class GitMirrorTimeoutError extends GitMirrorError {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorTimeoutError";
  }
}

export class GitMirrorWorktreeConflictError extends GitMirrorError {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorWorktreeConflictError";
  }
}
