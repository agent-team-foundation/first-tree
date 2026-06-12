import { join } from "node:path";
import { type AgentRuntimeConfigPayload, deriveRepoLocalPath, type WorkspaceRepoHealth } from "@first-tree/shared";
import { type PredeclaredSourceRepo, resolveBundledCliVersion } from "./bootstrap.js";
import { resolveGitRepoTargetPath } from "./git-local-path.js";
import type { GitMirrorManager } from "./git-mirror-manager.js";
import type { SessionContext } from "./handler.js";
import { readManagedState, updateManagedState } from "./managed-state.js";
import { isFinalRemoveOutcome, tryRemoveCloneSafely } from "./source-repo-cleanup.js";

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
  /**
   * True when the caller actually resolved `payload` from the server / config
   * cache — i.e. the empty / missing `gitRepos` field genuinely reflects the
   * agent's current configuration. False when the caller could not reach a
   * source of truth (cache miss) and fell back to a default-shaped payload
   * just to keep the session start moving.
   *
   * State-based cleanup of "previously managed source repos no longer in
   * config" ONLY runs when `payloadResolved === true`. Otherwise an
   * unresolved cache miss would compute `currentLocalPaths = []` and decide
   * every prev-recorded repo had been removed from config — `rm`-ing every
   * clean steady-state clone in the workspace. The non-state-tracking path
   * (clone / fetch the repos that ARE in `payload.gitRepos`) is unaffected
   * and runs regardless. See PR #869 review (code-reviewer P0-2) for the
   * regression this guards against.
   */
  payloadResolved: boolean;
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
 * Is the absolute checkout path currently held by at least one live chat in
 * THIS process? Used by the source-repo cleanup paths to refuse to delete a
 * checkout out from under a still-running chat (PR #869 P1-4).
 *
 * Cross-process awareness is out of scope — `liveChatsByPath` is per-process
 * state. Cross-process concurrency on the same workspace is already
 * unsupported (the workspace is per-agent; one daemon owns each agent).
 */
export function isSourceRepoPathInUse(absPath: string): boolean {
  return (liveChatsByPath.get(absPath)?.size ?? 0) > 0;
}

/**
 * Compute the set of source-repo localPaths the agent's CURRENT config
 * declares. The same derivation `prepareSourceRepos` uses internally,
 * exposed so handlers can thread the authoritative set through to
 * `ensureAgentBootstrap` (which forwards it as `MigrationContext
 * .currentSourceRepoNames`).
 *
 * Returns `null` when `payloadResolved` is `false` — that's the signal
 * downstream consumers use to defer config-dependent migrations and
 * suppress state-based cleanup. The non-null branch derives the same
 * `localPath ?? deriveRepoLocalPath(url)` rule that `prepareSourceRepos`
 * applies on its own materialisation loop.
 */
export function currentSourceRepoNamesFromPayload(
  payload: AgentRuntimeConfigPayload | undefined,
  payloadResolved: boolean,
): ReadonlySet<string> | null {
  if (!payloadResolved) return null;
  return new Set((payload?.gitRepos ?? []).map((repo) => repo.localPath ?? deriveRepoLocalPath(repo.url)));
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
 * Fail-fast, with three degrades:
 *  - transient *network* fetch failure on an already-existing usable checkout
 *    → `stale-offline`: the manager leaves the clone at its current commit so
 *    the agent stays answerable on the last-good source. Self-heals.
 *  - PERMISSION-shaped fetch failure on an existing usable checkout
 *    → `stale-unreachable`: same freeze, but reported as degraded health (it
 *    will not self-heal until host credentials are fixed).
 *  - PERMISSION-shaped clone failure with no usable local clone
 *    → `skipped-unreachable`: the repo is skipped (excluded from the returned
 *    `sourceRepos`) so the session still starts on a partial workspace.
 * Every other failure (corrupt, wrong origin, TLS trust, ref-not-found) still
 * aborts the session and bubbles up — see `classifyPermissionShapedGitError`.
 *
 * `repoHealth` carries one entry per configured repo (healthy ones included)
 * for the post-bootstrap `workspace:health` report. Transient `stale-offline`
 * is deliberately reported as `ok` — the warning surface is credential-
 * targeted and a network blip heals on the next session by itself.
 */
export type PrepareSourceReposResult = {
  sourceRepos: PredeclaredSourceRepo[];
  repoHealth: WorkspaceRepoHealth[];
};

export async function prepareSourceRepos(params: PrepareSourceReposParams): Promise<PrepareSourceReposResult> {
  const { workspace, payload, sessionCtx, gitMirrorManager, payloadResolved } = params;
  const sourceRepos: PredeclaredSourceRepo[] = [];
  const repoHealth: WorkspaceRepoHealth[] = [];

  // No git capability handle at all (test-only construction; the production
  // runtime always injects a manager) → no source-repo prep AND no cleanup
  // (we can't safely probe for clean state without git). Returns early before
  // any state read. The git-binary-missing case on a REAL host goes through
  // the manager and is classified `git_not_installed` per repo below.
  if (!gitMirrorManager) return { sourceRepos, repoHealth };

  // Build the set of `localPath`s the current config wants materialised.
  // `payload?.gitRepos` may legitimately be empty (config exists, just no
  // source repos) — the state-reconcile path below uses `payloadResolved`
  // (not the gitRepos length) to decide whether the empty set is
  // authoritative or just an unresolved fallback.
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

      // Degraded-workspace start: a permission-shaped clone failure skips the
      // repo instead of aborting the whole loop. Nothing was materialised on
      // disk (no `localPath` in the health entry), so the live-use
      // registration THIS call created is released right away — a skipped
      // repo must not pin the path into skip-update mode for other chats.
      if (result.outcome === "skipped-unreachable") {
        sessionCtx.log(
          `Git: ${localPath} could not be cloned (${result.degraded?.reasonCode ?? "permission-shaped failure"}) — repo skipped, session starts on a partial workspace`,
        );
        repoHealth.push({
          url: repo.url,
          status: "unreachable",
          ...(result.degraded ?? {}),
        });
        if (firstRegistration) releaseChatFromPath(sessionCtx.chatId, targetPath);
        continue;
      }

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
      } else if (result.outcome === "stale-offline") {
        sessionCtx.log(
          `Git: ${localPath} could not be fetched (transient network) — using existing local checkout, left at current commit (stale)`,
        );
      } else if (result.outcome === "stale-unreachable") {
        sessionCtx.log(
          `Git: ${localPath} could not be fetched (${result.degraded?.reasonCode ?? "permission-shaped failure"}) — using existing local checkout FROZEN at its last-good commit until host git credentials are fixed`,
        );
      }

      repoHealth.push(
        result.outcome === "stale-unreachable"
          ? {
              url: repo.url,
              localPath,
              status: "stale",
              ...(result.degraded ?? {}),
              ...(result.headCommit ? { headCommit: result.headCommit } : {}),
            }
          : { url: repo.url, localPath, status: "ok" },
      );

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
    //
    // GATED on `payloadResolved`: a cache miss / default-payload fallback
    // would produce an empty currentLocalPaths and falsely conclude that
    // every previously-managed repo had been removed from config. See the
    // field docstring on `PrepareSourceReposParams.payloadResolved` and
    // PR #869 review (code-reviewer P0-2).
    if (payloadResolved) {
      reconcileSourceRepoState(workspace, currentLocalPaths, sessionCtx);
    }
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

  return { sourceRepos, repoHealth };
}

/**
 * Compare the previously-managed source repos against the current set and
 * remove any whose `localPath` is no longer in the config. Safety guards
 * (working-tree clean + no extra worktrees + no local commits ahead of
 * upstream) protect against destroying in-flight work; a guard failure
 * skips the delete and logs a warning instead.
 *
 * **Retry semantics for skipped deletes.** A clone that the safety guards
 * refuse to remove (dirty / ahead-of-upstream / has-worktrees /
 * in-use-by-live-chat / probe-failed / remove-failed) stays in
 * `.first-tree-workspace/managed.json::sourceRepos` so the NEXT session's
 * reconcile re-runs the probes. The blocking condition is typically
 * operator-clearable between sessions (commit / push / close the dependent
 * worktree / end the live chat / fix permissions); once cleared, the
 * follow-up reconcile completes the delete.
 *
 * Only "final" outcomes — `removed` (we deleted it), `absent` (already
 * gone), or `not-a-clone` (structurally not ours to delete, ever) — drop
 * the entry from managed state and stop further retries. Log noise on
 * recurring skips is accepted as the cost of self-healing; the alternative
 * (forget about the orphan after one skip) leaves the operator with no
 * automatic cleanup once the blocker is resolved.
 */
function reconcileSourceRepoState(workspace: string, currentLocalPaths: string[], sessionCtx: SessionContext): void {
  const currentSet = new Set(currentLocalPaths);
  const retainedForRetry: string[] = [];
  const prev = readManagedState(workspace);
  if (prev) {
    for (const prevLocalPath of prev.sourceRepos) {
      if (currentSet.has(prevLocalPath)) continue;
      const absPath = join(workspace, prevLocalPath);
      const outcome = tryRemoveCloneSafely(absPath, prevLocalPath, sessionCtx.log, isSourceRepoPathInUse);
      // Recoverable skip → keep tracking this clone so the next session's
      // reconcile re-evaluates the safety guards. See the docstring above
      // for the full classification.
      if (!isFinalRemoveOutcome(outcome)) retainedForRetry.push(prevLocalPath);
    }
  }

  const nextSourceRepos = new Set([...currentSet, ...retainedForRetry]);
  updateManagedState(workspace, resolveBundledCliVersion(), (current) => ({
    ...current,
    sourceRepos: [...nextSourceRepos].sort(),
  }));
}
