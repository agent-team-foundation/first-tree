/**
 * Runtime-owned managed-session preparation for provider adapters.
 *
 * Owns the pre-provider admission sequence every normal start/resume shares.
 * Providers keep protocol / MCP / prompt translation and process admission;
 * this module does not spawn providers, create ACK authority, or load
 * provider config caches (callers pass already-resolved payload state).
 */

import type { AgentRuntimeConfig, AgentRuntimeConfigPayload, RuntimeProvider } from "@first-tree/shared";
import { ensureAgentBootstrap } from "../agent-bootstrap.js";
import { buildAgentBriefing } from "../agent-briefing.js";
import type { PredeclaredSourceRepo } from "../bootstrap.js";
import { type ChatContext, fetchChatContext } from "../chat-context.js";
import type { SessionContext } from "../handler.js";
import { type ReconciledTeamSkill, reconcileManagedSkillsForConfig } from "../managed-skills.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../source-repos.js";
import { teamSkillBundleResolverFromSdk } from "../team-skill-bundle-resolver.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../workspace.js";

/**
 * Context Tree coordinates carried into the briefing and the stable workspace
 * identity. Grouped because callers always supply the three values together.
 */
export type ContextTreeCoordinates = {
  path: string | null;
  repoUrl: string | null;
  branch: string | null;
};

export type PrepareManagedSessionParams = {
  sessionCtx: SessionContext;
  /** Absolute agent-home root passed to {@link acquireAgentHome}. */
  workspaceRoot: string;
  runtimeProvider: RuntimeProvider;
  /**
   * Live agent runtime config, or `null` when the caller had no config cache.
   * Supplies the Team Skill snapshot to the reconciler.
   */
  runtimeConfig: AgentRuntimeConfig | null;
  /** Effective payload — the caller's provider-specific default when unresolved. */
  payload: AgentRuntimeConfigPayload;
  /**
   * `false` when {@link payload} is a provider default rather than a resolved
   * config. Gates the authoritative workspace-manifest write so a fallback
   * empty repo set is never published as truth.
   */
  payloadResolved: boolean;
  contextTree: ContextTreeCoordinates;
  /**
   * Optional provider-owned **synchronous** checkpoint at Managed Skills
   * projection entry (first statement inside {@link projectManagedWorkspace},
   * before any await).
   *
   * Contract (enforced):
   * - Return type is `undefined` (not `void`) so `async` callbacks are a
   *   TypeScript error — `async () => …` is assignable to `() => void` but
   *   not to `() => undefined`.
   * - Runtime fail-closed: a returned thenable throws before reconcile.
   *
   * An `await` boundary here would reopen a microtask window where `suspend()`
   * can advance lifecycle generation before reconcile begins.
   */
  atProjectionEntry?: (args: { workspace: string; chatContext: ChatContext | undefined }) => undefined;
  /**
   * Optional provider-owned work after Managed Skills settle and before the
   * shared briefing / bootstrap / init-complete sentinel. Callers use this for
   * lifecycle fences (e.g. Pi generation checkpoints) and landing-campaign
   * sandbox env setup (Codex app-server) so cancellation/failure still leaves
   * no sentinel and no provider admission.
   */
  beforeBriefing?: (args: {
    workspace: string;
    chatContext: ChatContext | undefined;
    sourceRepos: readonly PredeclaredSourceRepo[];
    teamSkills: readonly ReconciledTeamSkill[];
  }) => void | Promise<void>;
};

export type PreparedManagedSession = {
  workspace: string;
  /**
   * Raw chat context, or `undefined` when the fetch failed or returned
   * nothing. Deliberately unrendered: per-chat context belongs to the caller's
   * provider/session prompt path, never to the shared agent-level briefing.
   */
  chatContext: ChatContext | undefined;
  /** Shared agent-level briefing already written to `<workspace>/AGENTS.md`. */
  briefing: string;
  sourceRepos: readonly PredeclaredSourceRepo[];
  /** Successful current-provider rows from the reconcile that gated this start. */
  teamSkills: readonly ReconciledTeamSkill[];
  /** Team Resource fence version from the reconcile that gated this start. */
  resourceConfigVersion: number;
};

export type ProjectManagedWorkspaceParams = {
  sessionCtx: SessionContext;
  /** Already-acquired agent home (no re-acquire). */
  workspace: string;
  runtimeProvider: RuntimeProvider;
  runtimeConfig: AgentRuntimeConfig | null;
  payload: AgentRuntimeConfigPayload;
  payloadResolved: boolean;
  contextTree: ContextTreeCoordinates;
  /**
   * Required: whether to write the init-complete sentinel after bootstrap.
   * Full admission passes true; mid-session refresh paths that historically
   * skipped the sentinel must pass false explicitly (no default footgun).
   */
  markInitComplete: boolean;
  /**
   * Optional provider-owned **synchronous** checkpoint at projection entry —
   * invoked before any await (including Managed Skills reconcile).
   * Return `undefined` (not `void`); runtime rejects thenables. See
   * {@link PrepareManagedSessionParams.atProjectionEntry}.
   */
  atProjectionEntry?: (args: { workspace: string }) => undefined;
  /**
   * Optional provider-owned checkpoint after Managed Skills settle and before
   * briefing / bootstrap / sentinel. Used for lifecycle fences and landing
   * sandbox env setup so cancellation/failure leaves no sentinel.
   */
  beforeBriefing?: (args: {
    workspace: string;
    sourceRepos: readonly PredeclaredSourceRepo[];
    teamSkills: readonly ReconciledTeamSkill[];
  }) => void | Promise<void>;
};

export type ProjectedManagedWorkspace = {
  briefing: string;
  sourceRepos: readonly PredeclaredSourceRepo[];
  teamSkills: readonly ReconciledTeamSkill[];
  /** Team Resource fence version from the reconcile that produced this projection. */
  resourceConfigVersion: number;
};

/**
 * Best-effort chat-context fetch. A failure degrades to no context with a log
 * rather than blocking the session: chat context enriches a prompt, it is not
 * an admission requirement.
 */
export async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
  try {
    return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
  } catch (err) {
    sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Invoke a projection-entry checkpoint without awaiting. TypeScript already
 * rejects `async` callbacks via the `() => undefined` return type; runtime
 * rejects any non-`undefined` return (including thenables) so a type-escape
 * cannot reopen the microtask race.
 */
function invokeSyncProjectionEntry(hook: (() => undefined) | undefined): void {
  if (!hook) return;
  const result: unknown = hook();
  if (result !== undefined) {
    throw new Error(
      `atProjectionEntry must be synchronous (must return undefined; got ${
        isThenable(result) ? "thenable" : typeof result
      })`,
    );
  }
}

/**
 * Reconcile Managed Skills, build the shared briefing, run agent bootstrap, and
 * optionally mark init-complete — without acquiring a home or fetching chat
 * context. Used by mid-session projection refresh paths that are not a full
 * start/resume admission.
 */
export async function projectManagedWorkspace(
  params: ProjectManagedWorkspaceParams,
): Promise<ProjectedManagedWorkspace> {
  const {
    sessionCtx,
    workspace,
    runtimeProvider,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree,
    markInitComplete,
    atProjectionEntry,
    beforeBriefing,
  } = params;

  // Sync fence — must run before any await so a queued suspend after a prior
  // await boundary cannot enter reconcile on a stale generation.
  if (atProjectionEntry) {
    invokeSyncProjectionEntry(() => atProjectionEntry({ workspace }));
  }

  const sourceRepos = declaredSourceRepos(workspace, payload);

  const { teamSkills, resourceConfigVersion } = await reconcileManagedSkillsForConfig(
    workspace,
    runtimeProvider,
    runtimeConfig,
    sessionCtx.log,
    teamSkillBundleResolverFromSdk(sessionCtx.sdk),
  );

  if (beforeBriefing) {
    // Only await when the hook actually returns a Promise. Sync lifecycle
    // checkpoints (Pi generation fences) must not hit an unconditional await
    // microtask window before briefing/bootstrap/sentinel.
    const result = beforeBriefing({ workspace, sourceRepos, teamSkills });
    if (result) {
      await result;
    }
  }

  const briefing = buildAgentBriefing({
    identity: sessionCtx.agent,
    payload,
    workspacePath: workspace,
    sourceRepos,
    contextTreePath: contextTree.path,
    contextTreeRepoUrl: contextTree.repoUrl,
    contextTreeBranch: contextTree.branch,
    teamSkills,
  });

  ensureAgentBootstrap({
    workspace,
    sessionCtx,
    contextTreePath: contextTree.path,
    briefing,
    currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
  });
  if (markInitComplete) {
    markWorkspaceInitComplete(workspace);
  }

  return { briefing, sourceRepos, teamSkills, resourceConfigVersion };
}

/**
 * Run the provider-neutral managed-session preparation that every normal
 * start/resume shares, in the order the runtime contract requires:
 *
 * 1. acquire the per-agent home;
 * 2. best-effort raw chat context (degrades to none on failure);
 * 3. declare the payload's source repos (after sync `atProjectionEntry`);
 * 4. settle Managed Skills — this gates provider admission, so a reconcile
 *    that cannot prove discovery safe throws here and leaves the delivery as
 *    unacked recovery debt;
 * 5. optional provider-owned `beforeBriefing` work (e.g. landing sandbox env);
 * 6. build the briefing from *that same* reconcile result;
 * 7. run the shared agent bootstrap;
 * 8. mark the workspace init-complete.
 *
 * Lifecycle fences that must close the post-await / pre-reconcile window use
 * synchronous {@link PrepareManagedSessionParams.atProjectionEntry} (invoked
 * as the first statement of {@link projectManagedWorkspace}, before any await).
 *
 * Preparation failure remains pre-provider: no provider process/session is
 * opened here, and no new ACK authority is created.
 */
export async function prepareManagedSession(params: PrepareManagedSessionParams): Promise<PreparedManagedSession> {
  const {
    sessionCtx,
    workspaceRoot,
    runtimeProvider,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree,
    atProjectionEntry,
    beforeBriefing,
  } = params;

  const workspace = acquireAgentHome(workspaceRoot);
  const chatContext = await fetchChatContextOrLog(sessionCtx);

  const projected = await projectManagedWorkspace({
    sessionCtx,
    workspace,
    runtimeProvider,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree,
    markInitComplete: true,
    atProjectionEntry: atProjectionEntry
      ? () => {
          // Must not discard a non-undefined return — that would recreate the
          // `async () => …` assignable-to-void escape the sync contract forbids.
          const result: unknown = atProjectionEntry({ workspace, chatContext });
          if (result !== undefined) {
            throw new Error(
              `atProjectionEntry must be synchronous (must return undefined; got ${
                isThenable(result) ? "thenable" : typeof result
              })`,
            );
          }
          return undefined;
        }
      : undefined,
    beforeBriefing: beforeBriefing ? (args) => beforeBriefing({ ...args, chatContext }) : undefined,
  });

  return {
    workspace,
    chatContext,
    briefing: projected.briefing,
    sourceRepos: projected.sourceRepos,
    teamSkills: projected.teamSkills,
    resourceConfigVersion: projected.resourceConfigVersion,
  };
}

export type { AgentBootstrapParams } from "../agent-bootstrap.js";
// Lower-level Runtime-owned preparation symbols for hot-switch / legacy paths
// that are not a full admission. Re-export owner bindings so identity is
// preserved (no façade wrappers).
export { ensureAgentBootstrap } from "../agent-bootstrap.js";
export type { BuildAgentBriefingOptions } from "../agent-briefing.js";
export { buildAgentBriefing } from "../agent-briefing.js";
export type { ChatContext } from "../chat-context.js";
export { fetchChatContext } from "../chat-context.js";
export type { ReconciledTeamSkill, ReconcileManagedSkillsResult } from "../managed-skills.js";
export {
  isManagedSkillsUnsafeDiscoveryError,
  reconcileManagedSkills,
  reconcileManagedSkillsForConfig,
} from "../managed-skills.js";
export { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../source-repos.js";
export { teamSkillBundleResolverFromSdk } from "../team-skill-bundle-resolver.js";
export { acquireAgentHome, markWorkspaceInitComplete } from "../workspace.js";
