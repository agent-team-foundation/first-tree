import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  agentConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  loadAgents,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { FirstTreeHubSDK } from "@first-tree-hub/client";

/**
 * A local agent alias whose `agent.yaml::agentId` is no longer in the set
 * the server reports as pinned to this client + owned by the caller.
 *
 * Stale aliases are the dominant cause of the "client doctor says N agents,
 * runtime only binds M" mismatch — they accumulate across `client claim`,
 * agent deletion, and bare-typo `agent add` mistakes (e.g. an alias named
 * `d`). Runtime tries to bind them every start, fails the R-RUN check,
 * and only logs a generic `failed to start agent`.
 */
export type StaleAlias = {
  name: string;
  agentId: string;
};

/**
 * Compare local `agents/<name>/agent.yaml::agentId` against the server's
 * `/api/v1/clients/me/agents` (every agent pinned to a client owned by
 * the caller). Returns the set of local alias dirs that don't map to
 * any server-side row — safe to delete.
 */
export async function findStaleAliases(opts: {
  serverUrl: string;
  getAccessToken: () => Promise<string>;
}): Promise<StaleAlias[]> {
  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  if (!existsSync(agentsDir)) return [];

  const local = loadAgents({ schema: agentConfigSchema, agentsDir });
  if (local.size === 0) return [];

  const sdk = new FirstTreeHubSDK({ serverUrl: opts.serverUrl, getAccessToken: opts.getAccessToken });
  const remote = await sdk.listMyAgents();
  const pinnedAgentIds = new Set(remote.map((a) => a.agentId));

  const stale: StaleAlias[] = [];
  for (const [name, cfg] of local) {
    if (!pinnedAgentIds.has(cfg.agentId)) {
      stale.push({ name, agentId: cfg.agentId });
    }
  }
  return stale;
}

/**
 * Remove an agent's local footprint: the YAML alias dir, the workspace
 * tree under `data/workspaces/<name>`, and the session-mapping file under
 * `data/sessions/<name>.json`. Mirrors what `agent remove` does, exposed
 * separately so prune and claim can share it.
 *
 * Best-effort: missing paths are silently ignored (the alias might have
 * been removed manually after a previous failed prune).
 */
export function removeLocalAgent(name: string): void {
  rmSync(join(DEFAULT_CONFIG_DIR, "agents", name), { recursive: true, force: true });
  rmSync(join(DEFAULT_DATA_DIR, "workspaces", name), { recursive: true, force: true });
  rmSync(join(DEFAULT_DATA_DIR, "sessions", `${name}.json`), { force: true });
}
