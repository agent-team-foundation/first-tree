import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootstrapWorkspace,
  deepEqualIdentity,
  installCoreSkills,
  installFirstTreeIntegration,
  readCachedBundledCliVersion,
  readCachedContextTreeHead,
  readContextTreeHead,
  resolveBundledCliVersion,
  writeBundledCliVersion,
  writeContextTreeHead,
} from "./bootstrap.js";
import type { AgentIdentity, SessionContext } from "./handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "./workspace.js";

export type AgentBootstrapParams = {
  workspace: string;
  sessionCtx: SessionContext;
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
  /** Stable workspace id for the integrate shell-out; falls back to agent id. */
  agentName: string | null;
};

/**
 * Generate the **stable** CLAUDE.md materialised at the agent home root.
 *
 * Per agent-session-cwd-redesign: this file contains only agent-level content
 * (identity, org domain map, Context Tree pointer, tools reference). Per-chat
 * content is injected per turn (via the SDK `appendSystemPrompt` or the TUI
 * `--append-system-prompt`) so two concurrent chats sharing this cwd never see
 * each other's data on disk.
 *
 * Per PRD D7 the agent's behavior instructions live in server-managed
 * `agent_configs.payload.prompt.append`, not in this file.
 */
export function generateStableClaudeMd(
  workspacePath: string,
  identity: AgentIdentity,
  contextTreePath: string | null,
): void {
  const sections: string[] = [];
  const contextDir = join(workspacePath, ".agent", "context");

  // --- Identity ---
  // Post-type-merge (migration 0051): the "personal assistant" vs "autonomous
  // bot" framing is carried by `agents.visibility`, not `delegateMention`.
  const name = identity.displayName ?? identity.agentId;
  if (identity.visibility === "private") {
    sections.push(`# Agent Identity\n\nYou are ${name}, a personal assistant agent.\n`);
  } else {
    sections.push(`# Agent Identity\n\nYou are ${name}, an autonomous agent.\n`);
  }

  // --- Context Tree operating instructions (AGENT.md) ---
  const agentInstructionsPath = join(contextDir, "agent-instructions.md");
  if (existsSync(agentInstructionsPath)) {
    const instructions = readFileSync(agentInstructionsPath, "utf-8");
    sections.push(`## Operating Instructions\n\n${instructions}\n`);
  }

  // --- Organization domain map (root NODE.md) ---
  const domainMapPath = join(contextDir, "domain-map.md");
  if (existsSync(domainMapPath)) {
    const domainMap = readFileSync(domainMapPath, "utf-8");
    sections.push(`## Organization Domain Map\n\n${domainMap}\n`);
  }

  // --- Context Tree location for on-demand reading ---
  if (contextTreePath) {
    sections.push(
      `## Context Tree Location\n\nThe full Context Tree is available at: \`${contextTreePath}\`\n\nRead specific domain nodes as needed following the operating instructions above.\n`,
    );
  }

  // --- Tools reference ---
  const toolsPath = join(workspacePath, ".agent", "tools.md");
  if (existsSync(toolsPath)) {
    const toolsContent = readFileSync(toolsPath, "utf-8");
    sections.push(toolsContent);
  }

  writeFileSync(join(workspacePath, "CLAUDE.md"), sections.join("\n"), "utf-8");
}

/**
 * Hash-check the existing identity.json against current agent metadata and
 * rewrite the stable `.agent/` section + CLAUDE.md only when something changed.
 * Runs OUT of the sentinel gate so agent rename / inboxId / metadata edits
 * still propagate after first bootstrap (proposal R5).
 */
function ensureStableIdentity(workspace: string, sessionCtx: SessionContext, contextTreePath: string | null): void {
  const identityPath = join(workspace, ".agent", "identity.json");
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
  // Mismatch (or missing / corrupt) — re-run the stable bootstrap so context/,
  // tools.md, the boundary marker, and identity.json line up with the current
  // agent metadata. Cheap relative to integrate / git.
  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    contextTreePath,
    serverUrl: sessionCtx.sdk.serverUrl,
  });
  generateStableClaudeMd(workspace, sessionCtx.agent, contextTreePath);
}

/**
 * Run the agent-home bootstrap that every Claude-driven handler shares: stable
 * `.agent/` layout + CLAUDE.md briefing, core-skill install, and (for
 * Context-Tree-bound agents) `first-tree tree integrate`. Gated by the stage-2
 * sentinel + Context-Tree-HEAD / CLI-version drift detection so a changed tree
 * or a `first-tree upgrade` forces a refresh, while the steady-state path is a
 * cheap identity check.
 *
 * Extracted from the claude-code SDK handler so the claude-code-tui handler
 * gets the identical briefing/skill/drift contract instead of a partial copy.
 */
export function ensureAgentBootstrap(params: AgentBootstrapParams): void {
  const { workspace, sessionCtx, contextTreePath, contextTreeRepoUrl, agentName } = params;

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
  // shipped skills payload tracks `first-tree upgrade` even when the Context
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
    return;
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
  generateStableClaudeMd(workspace, sessionCtx.agent, contextTreePath);

  // Core skills (`attention`) ship with every agent, tree or not — the slimmed
  // tools.md only carries a pointer, so the payload must exist before the first
  // turn. Degrade gracefully when the CLI is unavailable.
  installCoreSkills({
    workspacePath: workspace,
    log: (msg) => sessionCtx.log(msg),
  });

  let integrationOk = true;
  if (contextTreePath) {
    integrationOk = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath,
      workspaceId: agentName ?? sessionCtx.agent.agentId,
      treeRepoUrl: contextTreeRepoUrl ?? undefined,
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
}
