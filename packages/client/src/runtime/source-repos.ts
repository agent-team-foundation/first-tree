import { existsSync } from "node:fs";
import { type AgentRuntimeConfigPayload, deriveRepoLocalPath } from "@first-tree/shared";
import { isHubWorktreeMarker, type PredeclaredSourceRepo } from "./bootstrap.js";
import { resolveGitRepoTargetPath } from "./git-local-path.js";
import { deriveSessionBranchName, type GitMirrorManager } from "./git-mirror-manager.js";
import type { SessionContext } from "./handler.js";
import { withWorktreePathLock } from "./worktree-mutex.js";

export type PrepareSourceReposParams = {
  workspace: string;
  payload: AgentRuntimeConfigPayload | undefined;
  sessionCtx: SessionContext;
  gitMirrorManager: GitMirrorManager | null;
  /** Branch-owner key; falls back to the agent id when null. */
  agentName: string | null;
};

/**
 * Materialise a payload's predeclared `gitRepos` into the agent home and return
 * the prompt-facing source-repo list (absolute path + upstream coordinates).
 * Shared by the claude-code (SDK) and claude-code-tui handlers so the
 * worktree-path mutex and Hub-worktree-marker reuse semantics stay in one place.
 *
 * Concurrency: per-process per-path mutex (`withWorktreePathLock`) so two
 * sessions starting at the same time don't race `git worktree add` for the
 * same path. Reuse only when the target is a Hub-managed worktree
 * (`isHubWorktreeMarker`); a non-First Tree directory at the target is logged
 * and left to `createWorktree` to fail loudly rather than being silently
 * adopted as a source repo.
 *
 * Fail-fast per PRD D10/D13/D14: any failure aborts the session and bubbles up.
 */
export async function prepareSourceRepos(params: PrepareSourceReposParams): Promise<PredeclaredSourceRepo[]> {
  const { workspace, payload, sessionCtx, gitMirrorManager, agentName } = params;
  const sourceRepos: PredeclaredSourceRepo[] = [];

  if (!gitMirrorManager || !payload?.gitRepos?.length) return sourceRepos;

  for (const repo of payload.gitRepos) {
    const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
    // Source repos live at the TOP LEVEL of the agent home — no `worktrees/`
    // prefix. The `worktrees/` subdir is reserved for on-demand worktrees.
    const targetPath = resolveGitRepoTargetPath(workspace, localPath);
    sessionCtx.log(`Git: preparing source repo ${repo.url} → ${localPath}${repo.ref ? ` @ ${repo.ref}` : ""}`);

    // D14: ensureMirror is idempotent — clone once, fast return thereafter.
    const mirror = await gitMirrorManager.ensureMirror(repo.url);
    if (mirror.cloned) {
      sessionCtx.log(`Git: cloned ${repo.url} in ${mirror.elapsedMs}ms`);
    }

    // D10: fresh fetch on every new dialog. Failure aborts session creation.
    await gitMirrorManager.fetchMirror(repo.url);

    const branchAgentKey = agentName ?? sessionCtx.agent.agentId;

    // Serialise per absolute path so two concurrent sessions for the same
    // agent can't both try to create the same checkout.
    const { branchName } = await withWorktreePathLock(targetPath, async () => {
      if (existsSync(targetPath)) {
        if (isHubWorktreeMarker(targetPath)) {
          sessionCtx.log(`Git: reusing existing source repo at ${localPath}`);
          // Reuse path: branchName is deterministic for cleanup. With the
          // per-agent shared-checkout model, sessionKey is the agentName (not
          // chatId) so a checkout created by chat A is reused by chat B.
          return {
            branchName: deriveSessionBranchName(branchAgentKey, branchAgentKey, repo.url),
            headCommit: null as string | null,
          };
        }
        // Path occupied by a non-First Tree directory (operator placed it,
        // leftover from an old layout, etc). Log it explicitly — createWorktree
        // below will likely fail with a generic "path exists" error, and
        // without this line the operator has no way to know why.
        sessionCtx.log(
          `Git: source-repo target ${localPath} occupied by a non-First Tree directory; ` +
            "createWorktree will likely fail — move or remove the directory and re-run",
        );
      }
      const created = await gitMirrorManager.createWorktree({
        url: repo.url,
        ref: repo.ref,
        targetPath,
        // sessionKey identifies the branch *owner*. In the per-agent-home model
        // the owner is the agent, not the chat.
        sessionKey: branchAgentKey,
        agentName: branchAgentKey,
      });
      return { branchName: created.branchName, headCommit: created.headCommit as string | null };
    });

    // Per agent-session-cwd-redesign: predeclared source repos are agent-scoped
    // persistent resources. They survive shutdown so the next chat finds them
    // ready — so they are NOT tracked in the per-session worktree-cleanup list.
    sourceRepos.push({
      absolutePath: targetPath,
      url: repo.url,
      ...(repo.ref ? { ref: repo.ref } : {}),
      branch: branchName,
    });

    sessionCtx.log(`Git: source repo at ${localPath} on ${branchName}`);
  }

  return sourceRepos;
}
