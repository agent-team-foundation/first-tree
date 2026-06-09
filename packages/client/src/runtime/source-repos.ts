import { type AgentRuntimeConfigPayload, deriveRepoLocalPath } from "@first-tree/shared";
import type { PredeclaredSourceRepo } from "./bootstrap.js";
import { resolveGitRepoTargetPath } from "./git-local-path.js";
import type { GitMirrorManager } from "./git-mirror-manager.js";
import type { SessionContext } from "./handler.js";

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
 * Fail-fast, with one degrade: a transient *network* fetch failure on an
 * already-existing usable checkout does NOT abort — the manager leaves the
 * clone at its current commit (`stale-offline`) so the agent stays answerable
 * on the last-good source. Every other failure (first-clone failure, auth,
 * corrupt, wrong origin, TLS trust) still aborts the session and bubbles up.
 */
export async function prepareSourceRepos(params: PrepareSourceReposParams): Promise<PredeclaredSourceRepo[]> {
  const { workspace, payload, sessionCtx, gitMirrorManager } = params;
  const sourceRepos: PredeclaredSourceRepo[] = [];

  if (!gitMirrorManager || !payload?.gitRepos?.length) return sourceRepos;

  // Paths THIS call newly registered the chat on — only these may be rolled
  // back on failure (see the catch). A resume that re-acquires an already-live
  // registration must NOT be rolled back, or a concurrent chat could reset the
  // shared checkout out from under the still-live chat.
  const newlyRegistered: string[] = [];
  try {
    for (const repo of payload.gitRepos) {
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
      } else if (result.outcome === "stale-offline") {
        sessionCtx.log(
          `Git: ${localPath} could not be fetched (transient network) — using existing local checkout, left at current commit (stale)`,
        );
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
