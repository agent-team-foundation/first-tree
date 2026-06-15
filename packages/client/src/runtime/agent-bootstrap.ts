import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootstrapWorkspace,
  deepEqualIdentity,
  IDENTITY_JSON_REL,
  installCoreSkills,
  installFirstTreeIntegration,
  readCachedBundledCliVersion,
  resolveBundledCliVersion,
  writeAgentBriefing,
  writeBundledCliVersion,
} from "./bootstrap.js";
import type { SessionContext } from "./handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "./workspace.js";
import { ensureWorkspaceManifest } from "./workspace-manifest.js";
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
   * config payload (`currentSourceRepoNamesFromPayload`). `null` when the
   * caller could not resolve a payload (cache miss, default-payload
   * fallback). Gates the workspace-manifest write and is threaded into
   * `applyPendingMigrations` so config-dependent migrations can defer
   * instead of acting on an empty fallback.
   */
  currentSourceRepoNames: ReadonlySet<string> | null;
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
export function ensureAgentBootstrap(params: AgentBootstrapParams): void {
  const { workspace, sessionCtx, contextTreePath, briefing, currentSourceRepoNames } = params;

  // One-shot workspace migrations: sweep legacy directory-structure residue
  // (UUID-named per-chat snapshots, the legacy `WHITEPAPER.md` symlink) the
  // moment we re-attach to an old workspace. Each migration runs at most
  // once per workspace — the applier persists its own marker file at
  // `.agent/migrations-applied.json` and skips already-applied ids on
  // subsequent calls. Cheap noop in the steady state.
  //
  // `currentSourceRepoNames` carries the live, resolved source-repo
  // localPaths through to the per-migration context so config-dependent
  // migrations can defer on an unresolved payload (cache miss).
  applyPendingMigrations(workspace, sessionCtx.log, { currentSourceRepoNames });

  // Make this a valid W1 workspace for the shipped First Tree skills: write
  // `<workspace>/.first-tree/workspace.json` naming the tree + bound
  // sources. The tree directory itself (`<workspace>/context-tree`) is
  // agent-managed — the agent clones it on first use per its briefing
  // protocol; the manifest may legitimately name a not-yet-materialised
  // tree. Runs every session (cheap + idempotent) so the manifest tracks
  // source-repo changes. Gated on BOTH a resolved tree binding and a resolved
  // source set — a null source set (cache miss) would write a manifest that
  // falsely claims zero sources, which `first-tree-seed`'s self-check reads.
  if (contextTreePath !== null && currentSourceRepoNames !== null) {
    ensureWorkspaceManifest(workspace, [...currentSourceRepoNames], sessionCtx.log);
  }

  const sentinelPresent = existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL));

  // CLI-version drift forces a fresh `installFirstTreeIntegration` so the
  // shipped skills payload tracks CLI upgrades. This is the ONLY content
  // drift key left: the skills payload is bundled with the client package,
  // so its content is keyed by CLI version — not by the Context Tree HEAD.
  // (The retired tree-HEAD drift check predates the unified briefing: it
  // refreshed tree-derived workspace copies that no longer exist. The agent
  // reads its tree clone directly and keeps it fresh per the briefing's
  // pull-before-read protocol; no runtime re-bootstrap is needed when the
  // tree moves.) Fail open: `null` on either side means "unknown".
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

  if (sentinelPresent && !cliDrifted && !integrationNeverPinned) {
    ensureStableIdentity(workspace, sessionCtx, contextTreePath);
    writeAgentBriefing(workspace, briefing);
    return;
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

  // Only pin the CLI version when integration ACTUALLY RAN and succeeded —
  // i.e. the agent is tree-bound. A tree-less session skips
  // `installFirstTreeIntegration` (so no skills land) but `integrationOk` stays
  // `true`; pinning here would set `cachedCliVersion` non-null, which then
  // defeats the `integrationNeverPinned` trigger when the agent later becomes
  // tree-bound (new-tree onboarding) — `ensureAgentBootstrap` would take the
  // fast path and never install `first-tree-seed`. Gating on `contextTreePath`
  // keeps the upgrade path's slow-bootstrap trigger intact.
  if (contextTreePath !== null && integrationOk) {
    writeBundledCliVersion(workspace, currentCliVersion);
  }
}
