// Pure declaration of an agent's predeclared source repos.
//
// Per the agent-managed-repos design the runtime performs NO git operations
// on source repos: it derives where each configured repo lives on disk and
// surfaces those coordinates (path + upstream URL + optional pinned ref) in
// the agent briefing. The agent itself materialises and refreshes the clones
// following the protocol injected into its briefing (`git clone --bare` on
// first use, `git fetch` before branching a task worktree), works exclusively
// in per-chat worktrees under `<agentHome>/worktrees/`, and cleans those
// worktrees up when the task closes (e.g. on PR merge).

import { type AgentRuntimeConfigPayload, deriveRepoLocalPath } from "@first-tree/shared";
import type { PredeclaredSourceRepo } from "./bootstrap.js";
import { resolveGitRepoTargetPath } from "./git-local-path.js";

/**
 * Compute the set of source-repo localPaths the agent's CURRENT config
 * declares. Exposed so handlers can thread the authoritative set through to
 * `ensureAgentBootstrap` (workspace manifest + migration context).
 *
 * Returns `null` when `payloadResolved` is `false` — i.e. the caller could
 * not resolve a payload from the server / config cache and fell back to a
 * default-shaped payload. Downstream consumers use `null` to defer
 * config-dependent decisions instead of acting on an empty set that does
 * not reflect the agent's real configuration.
 */
export function currentSourceRepoNamesFromPayload(
  payload: AgentRuntimeConfigPayload | undefined,
  payloadResolved: boolean,
): ReadonlySet<string> | null {
  if (!payloadResolved) return null;
  return new Set((payload?.gitRepos ?? []).map((repo) => repo.localPath ?? deriveRepoLocalPath(repo.url)));
}

/**
 * Map a payload's predeclared `gitRepos` to the prompt-facing source-repo
 * list (absolute path + upstream coordinates). Pure derivation — no
 * filesystem or git side effects; the listed paths may not exist yet (the
 * agent clones them on first use per its briefing protocol).
 *
 * Each repo resolves to the TOP LEVEL of the agent home
 * (`<agentHome>/<localPath>`) — the `worktrees/` subdir stays reserved for
 * the per-task worktrees the agent creates. `resolveGitRepoTargetPath`
 * still validates `localPath` (no escape, no absolute paths) so a
 * malicious config cannot point the briefing outside the agent home.
 */
export function declaredSourceRepos(
  workspace: string,
  payload: AgentRuntimeConfigPayload | undefined,
): PredeclaredSourceRepo[] {
  return (payload?.gitRepos ?? []).map((repo) => {
    const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
    return {
      absolutePath: resolveGitRepoTargetPath(workspace, localPath),
      url: repo.url,
      ...(repo.ref ? { ref: repo.ref } : {}),
    };
  });
}
