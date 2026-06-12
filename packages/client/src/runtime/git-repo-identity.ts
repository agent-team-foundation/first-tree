import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
 * `origin` remote URL of the repo at `gitRoot`, cached per root for the
 * process lifetime (a checkout's remote does not change mid-session, and
 * the daemon calls this on the tool-call hot path). Negative results are
 * cached too — a repo with no `origin` stays a non-tree repo. The git
 * invocation is bounded so a wedged process cannot stall the daemon
 * event loop (same stance as the git-status write tracker).
 */
const remoteUrlCache = new Map<string, string | null>();

export function gitRemoteOriginUrl(gitRoot: string): string | null {
  const cached = remoteUrlCache.get(gitRoot);
  if (cached !== undefined) return cached;
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
  remoteUrlCache.set(gitRoot, remote);
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
