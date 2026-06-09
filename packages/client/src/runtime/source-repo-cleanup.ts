// Shared safety-checked removal for a top-level source-repo clone.
//
// Used by two paths that both want "delete a clone the CLI no longer
// considers current, unless it has unpushed work":
//
//   - `source-repos.ts` — state-based cleanup of repos dropped from the
//     agent's config payload between sessions.
//   - `workspace-migrations.ts` — one-shot v1-orphan-ft-clones sweep of
//     legacy First-Tree clones that predate the state file entirely.
//
// Centralising the guards here means both callers refuse to delete a
// dirty / ahead-of-upstream / worktree-host clone uniformly. The function
// is best-effort: any guard probe failure conservatively SKIPS the delete
// and returns `false`, so the caller can decide whether to retry or
// move on.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Outcome of a single `tryRemoveCloneSafely` call. */
export type RemoveCloneOutcome =
  | "removed"
  | "absent"
  | "not-a-clone"
  | "in-use-by-live-chat"
  | "dirty"
  | "ahead-of-upstream"
  | "has-worktrees"
  | "probe-failed"
  | "remove-failed";

/**
 * Whether a removal outcome counts as "work complete; drop the entry from
 * managed state". The state-based reconcile path uses this to decide which
 * prev-but-no-longer-current entries can be forgotten vs. which must stay
 * tracked so the next session retries.
 *
 * Final outcomes (`removed`, `absent`, `not-a-clone`) all mean further
 * probing accomplishes nothing — the directory is gone, was already gone,
 * or is structurally not a clone we manage.
 *
 * Every other outcome (`dirty`, `ahead-of-upstream`, `has-worktrees`,
 * `in-use-by-live-chat`, `probe-failed`, `remove-failed`) reflects a
 * condition that an operator action (commit / push / close a worktree /
 * end a live session / fix permissions) can clear, so the next session's
 * probe might succeed. Those entries stay in managed state for retry.
 */
export function isFinalRemoveOutcome(outcome: RemoveCloneOutcome): boolean {
  return outcome === "removed" || outcome === "absent" || outcome === "not-a-clone";
}

/**
 * Optional callback the caller can pass to short-circuit deletion when the
 * checkout is still held by a live chat in this process. The state-based
 * cleanup path passes `isSourceRepoPathInUse` from `source-repos.ts`; the
 * migration path passes the same callback so the early-startup migration
 * sweep can't `rm` a path another concurrent chat has already acquired.
 *
 * Defaults to `() => false` for callers that don't track live-use state.
 */
export type IsPathInUse = (absPath: string) => boolean;

/**
 * Attempt to `rm -rf` the clone at `absPath`. Guards:
 *
 *   1. **dir missing**            → `absent` (noop)
 *   2. **not a real clone**       → `not-a-clone` (noop; not ours to delete)
 *   3. **working tree dirty**     → `dirty`
 *   4. **local commits ahead**    → `ahead-of-upstream`
 *   5. **dependent worktrees**    → `has-worktrees` (orphaning gitdirs)
 *   6. **probe failure**          → `probe-failed` (conservative skip)
 *   7. **rm itself failed**       → `remove-failed`
 *
 * Returns `removed` only when all probes succeeded AND the directory was
 * deleted. The log function is invoked with one explanatory line per
 * non-trivial outcome (any branch other than `absent`).
 */
export function tryRemoveCloneSafely(
  absPath: string,
  displayName: string,
  log: (msg: string) => void,
  isPathInUse: IsPathInUse = () => false,
): RemoveCloneOutcome {
  if (!existsSync(absPath)) return "absent";
  if (!existsSync(join(absPath, ".git"))) {
    log(`Clone cleanup: ${displayName} skipped — not a recognised clone (no .git)`);
    return "not-a-clone";
  }

  // Live-chat check FIRST — refuse to delete a checkout another live chat in
  // this process is still using (PR #869 P1-4). Earlier than the git probes
  // so a chat that's mid-`grep` doesn't see files vanish even briefly.
  if (isPathInUse(absPath)) {
    log(`Clone cleanup: ${displayName} skipped — in use by another live chat`);
    return "in-use-by-live-chat";
  }

  // Dirty check — `git status --porcelain` reports anything staged, unstaged,
  // or untracked. A probe failure (git crashed, repo corrupt) is treated as
  // "unknown" and we err on the safe side by skipping.
  const statusOutput = gitOutput(absPath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (statusOutput === null) {
    log(`Clone cleanup: ${displayName} skipped — git status probe failed`);
    return "probe-failed";
  }
  if (statusOutput !== "") {
    log(`Clone cleanup: ${displayName} skipped — working tree is dirty`);
    return "dirty";
  }

  // Local-commits-ahead check. A `null` from the helper means either "no
  // upstream configured" or a probe failure — both conservatively block the
  // delete because we cannot prove the work is safe to lose.
  const aheadCount = gitAheadOfUpstream(absPath);
  if (aheadCount === null) {
    log(`Clone cleanup: ${displayName} skipped — ahead-count probe inconclusive`);
    return "probe-failed";
  }
  if (aheadCount > 0) {
    log(`Clone cleanup: ${displayName} skipped — ${aheadCount} local commit(s) ahead of upstream`);
    return "ahead-of-upstream";
  }

  // Extra-worktree check — `git worktree list --porcelain` produces one
  // record per worktree separated by blank lines. The main checkout is one
  // of those; anything beyond that is a dependent worktree we'd orphan.
  const worktreeOutput = gitOutput(absPath, ["worktree", "list", "--porcelain"]);
  if (worktreeOutput === null) {
    log(`Clone cleanup: ${displayName} skipped — worktree probe failed`);
    return "probe-failed";
  }
  const worktreeRecords = worktreeOutput.split(/\n\s*\n/).filter((block) => block.trim().length > 0);
  if (worktreeRecords.length > 1) {
    log(`Clone cleanup: ${displayName} skipped — ${worktreeRecords.length - 1} dependent worktree(s) attached`);
    return "has-worktrees";
  }

  try {
    rmSync(absPath, { recursive: true, force: true });
    log(`Clone cleanup: ${displayName} removed (${absPath})`);
    return "removed";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`Clone cleanup: ${displayName} rm failed — ${reason.slice(0, 200)}`);
    return "remove-failed";
  }
}

/**
 * Run `git <args>` in `cwd` and return its trimmed stdout. Returns `null`
 * (not `""`) when the command crashes or times out so callers can
 * distinguish "command ran, empty output" from "command failed, skip
 * conservatively".
 */
export function gitOutput(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Count commits on HEAD ahead of the tracked upstream.
 *
 * Returns:
 *   - `0` when the repo has no HEAD at all (empty repo, `git init` with no
 *     commits yet) — there is literally nothing to lose, so this is safe.
 *   - `0` when HEAD == upstream tip.
 *   - `N > 0` when HEAD has N local commits past upstream.
 *   - `null` when HEAD exists but upstream tracking is missing OR
 *     `git rev-list` crashed — both genuinely unknown, callers
 *     conservatively treat as "skip cleanup".
 *
 * The HEAD pre-check distinguishes "empty repo, safe" from "has work, no
 * tracking, unsafe": both used to look the same to `git rev-list`.
 */
export function gitAheadOfUpstream(cwd: string): number | null {
  // No HEAD → no commits at all → nothing to lose by deleting.
  try {
    execFileSync("git", ["rev-parse", "--quiet", "--verify", "HEAD"], {
      cwd,
      timeout: 10_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return 0;
  }
  try {
    const head = execFileSync("git", ["rev-list", "--count", "@{u}..HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number.parseInt(head, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
