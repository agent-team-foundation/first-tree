import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalGitRepoUrl } from "@first-tree/shared";

/**
 * Repo-identity resolution for Context Tree attribution.
 *
 * The agent workflow keeps TWO kinds of local checkouts of the Context Tree
 * repo: the shared read clone the runtime binds as `contextTreePath`, and
 * per-task worktrees under `worktrees/<task>` where tree PRs are actually
 * authored. Path containment against `contextTreePath` only recognizes the
 * first kind, so every write made in a tree PR worktree was invisible to the
 * Context tab feed. These helpers answer the question containment cannot:
 * "does this path live in ANY checkout of the bound Context Tree repo?" —
 * by walking up to the nearest git root and comparing its `origin` remote,
 * in canonical form, against the binding's repo URL.
 */

/**
 * Nearest ancestor (including `path` itself) containing a `.git` entry.
 * Works for clones (`.git` directory) and linked worktrees (`.git` file).
 * Pure filesystem walk — no git process. Returns null when no repo
 * encloses the path.
 */
export function findGitRepoRoot(path: string): string | null {
  let current = path;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `origin` remote URL of the repo at `gitRoot`, cached per root and
 * validated against the identity of the `.git` entry (inode + mtime).
 *
 * A plain path-keyed process-lifetime cache would be wrong here:
 * `worktrees/<task>` paths are an on-demand namespace — a worktree can be
 * removed and the same path recreated as a checkout of a DIFFERENT repo
 * without the daemon restarting. Re-stating `.git` on every lookup makes
 * recycling self-invalidating (a recreated `.git` has a new inode), at the
 * cost of one stat per lookup. A churned-but-same repo (e.g. the clone's
 * `.git` dir mtime moving with normal git activity) merely re-reads the
 * remote — correctness never depends on the cache being warm. Negative
 * results are cached the same way. The git invocation is bounded so a
 * wedged process cannot stall the daemon event loop (same stance as the
 * git-status write tracker).
 */
type RemoteCacheEntry = { ino: number; mtimeMs: number; remote: string | null };
const remoteUrlCache = new Map<string, RemoteCacheEntry>();
const REMOTE_CACHE_MAX_ENTRIES = 256;

export function gitRemoteOriginUrl(gitRoot: string): string | null {
  let gitEntryStat: { ino: number; mtimeMs: number };
  try {
    const stat = statSync(join(gitRoot, ".git"));
    gitEntryStat = { ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    // The root vanished between discovery and lookup (worktree cleanup).
    remoteUrlCache.delete(gitRoot);
    return null;
  }

  const cached = remoteUrlCache.get(gitRoot);
  if (cached && cached.ino === gitEntryStat.ino && cached.mtimeMs === gitEntryStat.mtimeMs) {
    return cached.remote;
  }

  let remote: string | null = null;
  try {
    const raw = execFileSync("git", ["-C", gitRoot, "remote", "get-url", "origin"], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    })
      .toString("utf8")
      .trim();
    remote = raw.length > 0 ? raw : null;
  } catch {
    remote = null;
  }
  // Crude growth bound: the working set is a handful of checkouts; if the
  // map ever balloons (pathological path churn), start over rather than LRU.
  if (remoteUrlCache.size >= REMOTE_CACHE_MAX_ENTRIES) remoteUrlCache.clear();
  remoteUrlCache.set(gitRoot, { ...gitEntryStat, remote });
  return remote;
}

/** Test seam: the cache is process-global and tests create throwaway repos. */
export function clearGitRepoIdentityCacheForTests(): void {
  remoteUrlCache.clear();
}

/**
 * Root of the checkout enclosing `canonicalPath` IF that checkout is of the
 * repo identified by `repoUrl` (canonical URL comparison — https and
 * scp-like ssh spellings of the same repo match). Null otherwise.
 */
export function gitRepoRootMatchingRemote(canonicalPath: string, repoUrl: string): string | null {
  const expected = canonicalGitRepoUrl(repoUrl);
  if (!expected) return null;
  const root = findGitRepoRoot(canonicalPath);
  if (!root) return null;
  const remote = gitRemoteOriginUrl(root);
  if (!remote || canonicalGitRepoUrl(remote) !== expected) return null;
  return root;
}
