import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type AgentRuntimeConfigPayload, deriveRepoLocalPath } from "@first-tree/shared";
import { type PredeclaredSourceRepo, resolveBundledCliVersion } from "./bootstrap.js";
import { resolveGitRepoTargetPath } from "./git-local-path.js";
import type { GitMirrorManager } from "./git-mirror-manager.js";
import type { SessionContext } from "./handler.js";
import { readManagedState, updateManagedState } from "./managed-state.js";

export type PrepareSourceReposParams = {
  workspace: string;
  payload: AgentRuntimeConfigPayload | undefined;
  sessionCtx: SessionContext;
  gitMirrorManager: GitMirrorManager | null;
  /**
   * Branch-owner key; falls back to the agent id when null. Retained for API
   * compatibility with the handlers — no longer used for branch derivation now
   * that source repos are standalone clones on their real default branch.
   */
  agentName: string | null;
};

/**
 * In-process "live use" registry per source-repo checkout: absolute path → set
 * of live **chat ids** currently using that checkout. Source repos are
 * agent-scoped and shared across that agent's chats, so two live chats of the
 * same agent can reference one clone at once.
 *
 * Keyed by `chatId` (stable across a chat's start → suspend → resume), NOT by
 * the per-call `SessionContext` object: the runtime hands each resume a FRESH
 * `SessionContext`, so object keying would re-acquire on every resume and the
 * teardown (which only sees the current ctx) would never release the earlier
 * one — permanently pinning the path into skip-update mode.
 *
 * Decision B (per-agent-source-repo design): a destructive update
 * (`checkout -B` to the latest default branch) must NOT run while another live
 * chat is using the checkout — otherwise that chat's `grep` / file reads shift
 * mid-task. `prepareSourceRepos` registers the chat for the session's lifetime
 * and passes `activelyInUse = (some other live chat holds it)` to the manager,
 * which then leaves an in-use checkout at its current commit. The chat is
 * deregistered at teardown via `releaseSourceReposForSession` (and on a failed
 * start, by `prepareSourceRepos` itself).
 */
const liveChatsByPath = new Map<string, Set<string>>();

function acquireSourceRepo(chatId: string, absPath: string): { activelyInUse: boolean; firstRegistration: boolean } {
  const chats = liveChatsByPath.get(absPath) ?? new Set<string>();
  // "Active use by someone else" = a *different* live chat already holds it.
  // Adding our own chatId is idempotent, so start/suspend/resume of one chat
  // never double-registers.
  let othersUsing = false;
  for (const c of chats) {
    if (c !== chatId) {
      othersUsing = true;
      break;
    }
  }
  // `firstRegistration` tells the caller whether THIS call newly registered the
  // chat (vs the chat already being registered from a prior live start). Only a
  // first registration may be rolled back on failure — see prepareSourceRepos.
  const firstRegistration = !chats.has(chatId);
  chats.add(chatId);
  liveChatsByPath.set(absPath, chats);
  return { activelyInUse: othersUsing, firstRegistration };
}

function releaseChatFromPath(chatId: string, absPath: string): void {
  const chats = liveChatsByPath.get(absPath);
  if (!chats) return;
  if (chats.delete(chatId) && chats.size === 0) liveChatsByPath.delete(absPath);
}

/**
 * Deregister `sessionCtx`'s chat from every source-repo checkout it was using.
 * Idempotent — safe to call once per session teardown even if
 * `prepareSourceRepos` never ran.
 */
export function releaseSourceReposForSession(sessionCtx: SessionContext): void {
  const { chatId } = sessionCtx;
  for (const [absPath, chats] of liveChatsByPath) {
    if (chats.delete(chatId) && chats.size === 0) liveChatsByPath.delete(absPath);
  }
}

/**
 * Materialise a payload's predeclared `gitRepos` into the agent home as
 * standalone clones and return the prompt-facing source-repo list (absolute
 * path + upstream coordinates + checked-out branch). Shared by the claude-code
 * (SDK) and claude-code-tui handlers.
 *
 * Per the per-agent-source-repo refactor: each repo is a real `git clone` at
 * the TOP LEVEL of the agent home (NOT under `worktrees/`, which stays reserved
 * for on-demand worktrees the agent creates per task). Every dialog fetches and
 * — when the checkout is clean and not in use by another live session — brings
 * it to the latest default branch. Concurrency for the same path is serialised
 * inside the manager (`withPathLock`).
 *
 * Fail-fast: any clone/fetch failure aborts the session and bubbles up.
 */
export async function prepareSourceRepos(params: PrepareSourceReposParams): Promise<PredeclaredSourceRepo[]> {
  const { workspace, payload, sessionCtx, gitMirrorManager } = params;
  const sourceRepos: PredeclaredSourceRepo[] = [];

  // No git capability → no source-repo prep AND no cleanup (we can't safely
  // probe for clean state without git). Returns early before any state read.
  if (!gitMirrorManager) return sourceRepos;

  // Build the set of `localPath`s the current config wants materialised.
  // `payload?.gitRepos` may legitimately be empty (config exists, just no
  // source repos) — the reconcile-state path below still runs in that case
  // so a previously-managed repo whose name was removed from the config
  // gets cleaned up.
  const currentLocalPaths: string[] = (payload?.gitRepos ?? []).map(
    (repo) => repo.localPath ?? deriveRepoLocalPath(repo.url),
  );

  // Paths THIS call newly registered the chat on — only these may be rolled
  // back on failure (see the catch). A resume that re-acquires an already-live
  // registration must NOT be rolled back, or a concurrent chat could reset the
  // shared checkout out from under the still-live chat.
  const newlyRegistered: string[] = [];
  try {
    for (const repo of payload?.gitRepos ?? []) {
      const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
      // Source repos live at the TOP LEVEL of the agent home — no `worktrees/`
      // prefix. The `worktrees/` subdir is reserved for on-demand worktrees.
      const targetPath = resolveGitRepoTargetPath(workspace, localPath);
      sessionCtx.log(`Git: preparing source repo ${repo.url} → ${localPath}${repo.ref ? ` @ ${repo.ref}` : ""}`);

      // Decision B: register this chat as a live user of the checkout and learn
      // whether another live chat is already using it (→ skip the destructive
      // update).
      const { activelyInUse, firstRegistration } = acquireSourceRepo(sessionCtx.chatId, targetPath);
      if (firstRegistration) newlyRegistered.push(targetPath);

      const result = await gitMirrorManager.ensureSourceRepo({
        url: repo.url,
        ref: repo.ref,
        clonePath: targetPath,
        activelyInUse,
      });

      if (result.outcome === "cloned") {
        sessionCtx.log(`Git: cloned ${repo.url}`);
      } else if (result.outcome === "migrated-recloned") {
        sessionCtx.log(`Git: migrated legacy shared-mirror checkout of ${repo.url} to a standalone clone`);
      } else if (result.outcome === "skipped-dirty") {
        sessionCtx.log(`Git: ${localPath} has local changes — left at current commit (not updated to latest)`);
      } else if (result.outcome === "skipped-local-commits") {
        sessionCtx.log(`Git: ${localPath} has local commits ahead of upstream — left at current commit`);
      } else if (result.outcome === "skipped-in-use") {
        sessionCtx.log(`Git: ${localPath} in use by another live chat — left at current commit`);
      }

      // Per agent-session-cwd-redesign: predeclared source repos are agent-scoped
      // persistent resources. They survive shutdown so the next chat finds them
      // ready — so they are NOT tracked in the per-session worktree-cleanup list.
      sourceRepos.push({
        absolutePath: targetPath,
        url: repo.url,
        ...(repo.ref ? { ref: repo.ref } : {}),
        ...(result.branch ? { branch: result.branch } : {}),
      });

      sessionCtx.log(
        `Git: source repo at ${localPath}${result.branch ? ` on ${result.branch}` : ""} (${result.outcome})`,
      );
    }

    // State reconcile: a source repo that used to be in this agent's config
    // but is no longer present should be removed from disk. We only consider
    // repos this CLI previously recorded in `.agent/managed.json` — anything
    // the user dropped at workspace top level (third-party clones, manual
    // experiments) is untouched.
    reconcileSourceRepoState(workspace, currentLocalPaths, sessionCtx);
  } catch (err) {
    // Session start is failing and the SessionManager does NOT call the
    // handler's teardown on a failed start. Roll back ONLY the registrations
    // this call created so a dead chat does not pin the checkout into
    // skip-update mode — while leaving intact any registration that a still-live
    // chat already held (e.g. a transient failure on resume, which the manager
    // keeps alive for retry).
    for (const p of newlyRegistered) releaseChatFromPath(sessionCtx.chatId, p);
    throw err;
  }

  return sourceRepos;
}

/**
 * Compare the previously-managed source repos against the current set and
 * remove any whose `localPath` is no longer in the config. Safety guards
 * (working-tree clean + no extra worktrees + no local commits ahead of
 * upstream) protect against destroying in-flight work; a guard failure
 * skips the delete and logs a warning instead.
 *
 * State (the `sourceRepos` field of `.agent/managed.json`) is rewritten to
 * the current set whether or not deletes succeeded — so a future config
 * change correctly diffs against today's reality, and a guard-skipped
 * cleanup just becomes a manual operator follow-up rather than a
 * recurring noisy log.
 */
function reconcileSourceRepoState(workspace: string, currentLocalPaths: string[], sessionCtx: SessionContext): void {
  const currentSet = new Set(currentLocalPaths);
  const prev = readManagedState(workspace);
  if (prev) {
    for (const prevLocalPath of prev.sourceRepos) {
      if (currentSet.has(prevLocalPath)) continue;
      const absPath = join(workspace, prevLocalPath);
      attemptRemoveStaleSourceRepo(absPath, prevLocalPath, sessionCtx.log);
    }
  }

  updateManagedState(workspace, resolveBundledCliVersion(), (current) => ({
    ...current,
    sourceRepos: [...currentSet].sort(),
  }));
}

/**
 * Try to delete a source-repo checkout that's no longer in the agent's
 * config. Guards:
 *
 *   1. **dir missing**          → noop (already gone)
 *   2. **not a real clone**     → noop (not ours to delete)
 *   3. **working tree dirty**   → skip + warn
 *   4. **local commits ahead**  → skip + warn
 *   5. **extra worktrees**      → skip + warn (would orphan worktree gitdir)
 *
 * Any guard failure logs and returns without touching disk. Only when ALL
 * guards pass do we `rm -rf` the directory.
 */
function attemptRemoveStaleSourceRepo(absPath: string, displayName: string, log: (msg: string) => void): void {
  if (!existsSync(absPath)) return;
  if (!existsSync(join(absPath, ".git"))) {
    log(`Git: ${displayName} removed from config but not a recognised clone (no .git) — leaving in place`);
    return;
  }

  // Dirty check — `git status --porcelain` reports anything staged, unstaged,
  // or untracked. Same rule the mirror manager applies to skip destructive
  // updates of in-use clones. A probe failure (git crashed, repo corrupt)
  // is treated as "unknown" and we err on the safe side by skipping.
  const statusOutput = gitOutput(absPath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (statusOutput === null) {
    log(`Git: ${displayName} removed from config but git probe failed — left in place (cleanup skipped)`);
    return;
  }
  if (statusOutput !== "") {
    log(`Git: ${displayName} removed from config but working tree is dirty — left in place (cleanup skipped)`);
    return;
  }

  // Local-commits-ahead check — if HEAD is strictly ahead of the configured
  // upstream we'd lose unpushed work on rm. A `null` from the helper means
  // either "no upstream configured" (e.g. detached HEAD, fresh clone never
  // tracked) or a probe failure — both are conservatively treated as "skip".
  const aheadCount = gitAheadOfUpstream(absPath);
  if (aheadCount === null) {
    log(`Git: ${displayName} removed from config but ahead-count probe inconclusive — left in place (cleanup skipped)`);
    return;
  }
  if (aheadCount > 0) {
    log(
      `Git: ${displayName} removed from config but has ${aheadCount} local commit(s) ahead of upstream — left in place (cleanup skipped)`,
    );
    return;
  }

  // Extra-worktree check — `git worktree list --porcelain` produces one
  // record per worktree separated by blank lines. The main checkout is one
  // of those; anything beyond that is a dependent worktree we'd orphan. A
  // probe failure here also blocks the delete.
  const worktreeOutput = gitOutput(absPath, ["worktree", "list", "--porcelain"]);
  if (worktreeOutput === null) {
    log(`Git: ${displayName} removed from config but worktree probe failed — left in place (cleanup skipped)`);
    return;
  }
  const worktreeRecords = worktreeOutput.split(/\n\s*\n/).filter((block) => block.trim().length > 0);
  if (worktreeRecords.length > 1) {
    log(
      `Git: ${displayName} removed from config but has ${worktreeRecords.length - 1} dependent worktree(s) — left in place (cleanup skipped)`,
    );
    return;
  }

  try {
    rmSync(absPath, { recursive: true, force: true });
    log(`Git: ${displayName} removed from config — deleted clone at ${absPath}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`Git: ${displayName} cleanup failed (${reason.slice(0, 200)}) — left in place`);
  }
}

/**
 * Run `git <args>` in `cwd` and return its trimmed stdout. Returns `null`
 * (not `""`) when the command crashes / times out so callers can
 * distinguish "command ran, output empty" from "command failed,
 * conservatively skip".
 */
function gitOutput(cwd: string, args: readonly string[]): string | null {
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
 * Count commits on HEAD ahead of the tracked upstream. Returns `null` when
 * the count is genuinely unknown — either no upstream is configured
 * (e.g. fresh clone, detached HEAD) or the `git rev-list` itself crashed.
 * Callers conservatively treat `null` as "skip cleanup" rather than guess
 * a safe default.
 */
function gitAheadOfUpstream(cwd: string): number | null {
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
