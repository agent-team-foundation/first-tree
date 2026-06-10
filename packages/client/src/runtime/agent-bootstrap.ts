import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootstrapWorkspace,
  deepEqualIdentity,
  IDENTITY_JSON_REL,
  installCoreSkills,
  installFirstTreeIntegration,
  readCachedBundledCliVersion,
  readCachedContextTreeHead,
  readContextTreeHead,
  resolveBundledCliVersion,
  writeAgentBriefing,
  writeBundledCliVersion,
  writeContextTreeHead,
} from "./bootstrap.js";
import type { SessionContext } from "./handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "./workspace.js";
import { applyPendingMigrations } from "./workspace-migrations.js";

export type AgentBootstrapParams = {
  workspace: string;
  sessionCtx: SessionContext;
  contextTreePath: string | null;
  /**
   * Pre-rendered briefing for this turn. Built by {@link buildAgentBriefing}
   * and written to `<workspace>/AGENTS.md` on every start/resume (CLAUDE.md is
   * symlinked to it). The briefing changes per chat — Current Chat Context,
   * participants, and the latest agent config payload all flow through this
   * parameter — so callers MUST recompute it before every call instead of
   * caching across sessions.
   */
  briefing: string;
  /**
   * Authoritative source-repo `localPath` set from the live, resolved agent
   * config payload — same value `prepareSourceRepos` was called with. `null`
   * when the caller could not resolve a payload (cache miss, default-payload
   * fallback). Threaded into `applyPendingMigrations` as the `ctx
   * .currentSourceRepoNames` field so migrations that need an authoritative
   * current config (`v1-orphan-ft-clones`) can defer instead of acting on an
   * empty fallback. PR #869 baixiaohang round-3 P0.
   */
  currentSourceRepoNames: ReadonlySet<string> | null;
};

export type AgentBootstrapResult = {
  treeDrifted: boolean;
  cliDrifted: boolean;
  bootstrapped: boolean;
};

/**
 * Hash-check the existing identity.json against current agent metadata and
 * rewrite the stable `.first-tree-workspace/` section only when something
 * changed. Runs OUT
 * of the sentinel gate so agent rename / inboxId / metadata edits still
 * propagate after first bootstrap (proposal R5).
 *
 * The unified briefing is rewritten by the caller via {@link
 * writeAgentBriefing} on every start/resume regardless of this check —
 * identity drift only forces the heavier `.first-tree-workspace/` refresh.
 */
function ensureStableIdentity(workspace: string, sessionCtx: SessionContext, contextTreePath: string | null): void {
  const identityPath = join(workspace, IDENTITY_JSON_REL);
  const desired = {
    agentId: sessionCtx.agent.agentId,
    displayName: sessionCtx.agent.displayName,
    type: sessionCtx.agent.type,
    delegateMention: sessionCtx.agent.delegateMention,
    metadata: sessionCtx.agent.metadata,
    serverUrl: sessionCtx.sdk.serverUrl,
    contextTreePath,
  };
  if (existsSync(identityPath)) {
    try {
      const current = JSON.parse(readFileSync(identityPath, "utf-8"));
      if (deepEqualIdentity(current, desired)) return;
    } catch {
      // Corrupt JSON — fall through to rewrite via bootstrapWorkspace.
    }
  }
  // Mismatch (or missing / corrupt) — re-run the stable bootstrap so the
  // boundary marker and identity.json line up with the current agent
  // metadata. Cheap relative to integrate / git.
  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    contextTreePath,
    serverUrl: sessionCtx.sdk.serverUrl,
  });
}

/**
 * Run the agent-home bootstrap that every handler shares: stable
 * `.first-tree-workspace/` layout, unified briefing rewrite (AGENTS.md +
 * CLAUDE.md symlink), core-skill install, and (for Context-Tree-bound agents)
 * the inline first-tree skill
 * install (`installFirstTreeIntegration`, which copies bundled skill payloads
 * straight from `@first-tree/client`'s own `skills/` directory). Gated by the
 * stage-2 sentinel + Context-Tree-HEAD / Client-version drift detection so a
 * changed tree or a client upgrade forces a refresh, while the steady-state
 * path is a cheap identity check.
 *
 * The unified briefing is **always rewritten** on every call, irrespective of
 * drift — it carries per-chat content (chat ID, participants, source-repo
 * list, current payload prompt.append) that changes between sessions for the
 * same agent home. See proposal §⓪.3 for the race window this accepts.
 */
export function ensureAgentBootstrap(params: AgentBootstrapParams): AgentBootstrapResult {
  const { workspace, sessionCtx, contextTreePath, briefing, currentSourceRepoNames } = params;

  // One-shot workspace migrations: sweep legacy directory-structure residue
  // (UUID-named per-chat snapshots, the legacy `WHITEPAPER.md` symlink,
  // retired source-repo clones like `first-tree-hub/`) the moment we
  // re-attach to an old workspace. Each migration runs at most once per
  // workspace — the applier persists its own marker file at
  // `.agent/migrations-applied.json` and skips already-applied ids on
  // subsequent calls. Cheap noop in the steady state.
  //
  // `currentSourceRepoNames` carries the live, resolved source-repo
  // localPaths through to the per-migration context; migrations that need
  // an authoritative current set (e.g. `v1-orphan-ft-clones`) return
  // `"deferred"` when it's null and retry on a future resolved session
  // (PR #869 baixiaohang round-3 P0).
  applyPendingMigrations(workspace, sessionCtx.log, { currentSourceRepoNames });

  const sentinelPresent = existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL));
  const currentTreeHead = readContextTreeHead(contextTreePath);
  const cachedTreeHead = readCachedContextTreeHead(workspace);
  // Only treat as drift when both values are known AND differ — `null` on
  // either side means "unknown", so we fall back to the sentinel-only decision
  // (fail open). Warn on the asymmetry so a transient `git rev-parse` failure
  // doesn't silently disable drift detection.
  if (cachedTreeHead !== null && currentTreeHead === null) {
    sessionCtx.log(
      `Context Tree HEAD probe returned null while cached value is ` +
        `${cachedTreeHead.slice(0, 7)}; drift detection bypassed for this start`,
    );
  }
  const treeDrifted = currentTreeHead !== null && cachedTreeHead !== null && currentTreeHead !== cachedTreeHead;

  // CLI-version drift forces a fresh `installFirstTreeIntegration` so the
  // shipped skills payload tracks CLI upgrades even when the Context
  // Tree HEAD is unchanged. Same fail-open rule as tree drift.
  const currentCliVersion = resolveBundledCliVersion();
  const cachedCliVersion = readCachedBundledCliVersion(workspace);
  const cliDrifted = currentCliVersion !== null && cachedCliVersion !== null && currentCliVersion !== cachedCliVersion;

  // A tree-bound agent only pins its CLI version after `installFirstTreeIntegration`
  // SUCCEEDS (see the integrationOk gate below). So a missing CLI pin on a
  // tree-bound agent means integration has never succeeded — force the slow
  // path to retry it rather than freezing behind the sentinel without skills /
  // briefing. Guard on `currentCliVersion !== null`: when the CLI version is
  // unknown we can't pin one anyway, so fall back to the sentinel-only decision
  // (no perpetual re-integration in version-less environments).
  const integrationNeverPinned = contextTreePath !== null && currentCliVersion !== null && cachedCliVersion === null;

  if (sentinelPresent && !treeDrifted && !cliDrifted && !integrationNeverPinned) {
    ensureStableIdentity(workspace, sessionCtx, contextTreePath);
    writeAgentBriefing(workspace, briefing);
    return { treeDrifted, cliDrifted, bootstrapped: false };
  }

  if (sentinelPresent && treeDrifted) {
    sessionCtx.log(
      `Context Tree HEAD changed (${cachedTreeHead?.slice(0, 7)} → ${currentTreeHead?.slice(0, 7)}); re-running bootstrap`,
    );
  }
  if (sentinelPresent && cliDrifted) {
    sessionCtx.log(
      `Bundled CLI version changed (${cachedCliVersion} → ${currentCliVersion}); re-running bootstrap to refresh skills`,
    );
  }

  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    contextTreePath,
    serverUrl: sessionCtx.sdk.serverUrl,
  });
  writeAgentBriefing(workspace, briefing);

  // Core skills ship with every agent, tree or not. The core skill set is
  // currently empty so this is effectively a no-op, but the wiring stays so
  // re-introducing one needs no bootstrap change. Degrade gracefully when the
  // CLI is unavailable.
  installCoreSkills({
    workspacePath: workspace,
    log: (msg) => sessionCtx.log(msg),
  });

  let integrationOk = true;
  if (contextTreePath) {
    integrationOk = installFirstTreeIntegration({
      workspacePath: workspace,
      log: (msg) => sessionCtx.log(msg),
    });
  }

  // Pin the current HEAD so the next start can detect drift.
  writeContextTreeHead(workspace, currentTreeHead);
  // Only pin the CLI version when integrate actually succeeded — pinning on a
  // failed run would mask the gap and skip the retry this trigger exists for.
  if (integrationOk) {
    writeBundledCliVersion(workspace, currentCliVersion);
  }
  return { treeDrifted, cliDrifted, bootstrapped: true };
}
