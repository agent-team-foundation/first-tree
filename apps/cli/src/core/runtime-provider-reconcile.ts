import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSessionRegistryPath } from "@first-tree/client";
import type { ClientCapabilities, RuntimeProvider, SkillDescriptor } from "@first-tree/shared";
import { DEFAULT_RUNTIME_PROVIDER } from "@first-tree/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { cliFetch } from "./cli-fetch.js";

type LogFn = (level: "info" | "warn", msg: string) => void;

type AuthoritativePinnedAgent = {
  agentId: string;
  clientId: string;
  runtimeProvider: RuntimeProvider;
  status?: string;
};

export type PinnedAgentRuntimeRecord = AuthoritativePinnedAgent;

export async function listPinnedAgents(opts: {
  serverUrl: string;
  accessToken: string;
}): Promise<PinnedAgentRuntimeRecord[]> {
  const res = await cliFetch(`${opts.serverUrl}/api/v1/me/pinned-agents`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on /me/pinned-agents`);
  }
  return (await res.json()) as PinnedAgentRuntimeRecord[];
}

/**
 * Pre-flight reconciliation called before the agents loop spawns. Pulls
 * authoritative `runtime_provider` for every non-deleted agent the calling
 * user owns and rewrites any local `agent.yaml` whose `runtime` field
 * disagrees. Suspended agents stay in this ownership list so their local
 * footprint is preserved while disabled. Best-effort: a transient server failure
 * logs and falls back to the local YAML value (the in-band repair path catches
 * any remaining drift on first bind).
 */
export async function reconcileLocalRuntimeProviders(opts: {
  serverUrl: string;
  accessToken: string;
  agentsDir: string;
  log?: LogFn;
}): Promise<void> {
  const items = await listPinnedAgents(opts);
  const byAgentId = new Map(items.map((it) => [it.agentId, it]));

  if (!existsSync(opts.agentsDir)) return;
  const subdirs = readdirSync(opts.agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const subdir of subdirs) {
    const yamlPath = join(opts.agentsDir, subdir.name, "agent.yaml");
    if (!existsSync(yamlPath)) continue;
    let parsed: { agentId?: string; runtime?: string } & Record<string, unknown>;
    try {
      const raw = readFileSync(yamlPath, "utf-8");
      parsed = parseYaml(raw) ?? {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.("warn", `agent ${subdir.name}: cannot parse yaml — ${msg}`);
      continue;
    }
    if (!parsed.agentId) continue;
    const auth = byAgentId.get(parsed.agentId);
    if (!auth) continue;
    if (parsed.runtime === auth.runtimeProvider) continue;

    // The *effective* local provider is what `loadAgents()` will hand the slot:
    // `agentConfigSchema` defaults an omitted `runtime` to DEFAULT_RUNTIME_PROVIDER.
    // A legacy config that just omits `runtime` (effective `claude-code`) against
    // a server `claude-code` is NOT a switch — the same handler launches either
    // way — even though the raw YAML value (`undefined`) differs. The registry
    // clear must key off this effective comparison, not the raw field, or it
    // would delete valid session mappings on every startup for defaulted configs.
    const effectiveLocal = parsed.runtime ?? DEFAULT_RUNTIME_PROVIDER;
    const providerChanged = effectiveLocal !== auth.runtimeProvider;

    const next = { ...parsed, runtime: auth.runtimeProvider };
    try {
      writeFileSync(yamlPath, stringifyYaml(next), { mode: 0o600 });
      opts.log?.(
        "info",
        `agent ${parsed.agentId}: yaml runtime "${parsed.runtime ?? "(unset)"}" → "${auth.runtimeProvider}" (server authoritative)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.("warn", `agent ${parsed.agentId}: failed to rewrite yaml — ${msg}`);
      // Yaml unchanged → the slot still starts on the old provider, for which
      // the persisted session registry is still valid. Leave it alone.
      continue;
    }
    // Only a real change in the effective provider invalidates the registry.
    // Materializing an omitted field to the same provider (above) is not a
    // switch, so the OLD provider's native session ids stay valid and must be
    // preserved. When the provider genuinely changed, clear them so every chat
    // cold-starts under the new provider (a Claude session id is meaningless to
    // Codex `resumeThread` and vice versa) — mirroring the live hot-swap path,
    // for the offline-rebind case where reconciliation applies the switch
    // before the slot first binds.
    if (!providerChanged) continue;
    try {
      rmSync(agentSessionRegistryPath(subdir.name), { force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.("warn", `agent ${parsed.agentId}: failed to clear session registry after runtime switch — ${msg}`);
    }
  }
}

/**
 * Member-scoped capabilities upload. Server stores the snapshot under
 * `clients.metadata.capabilities`. Best-effort: failure does not block
 * client startup since capabilities only matter for UI / admin checks.
 */
export async function uploadClientCapabilities(opts: {
  serverUrl: string;
  accessToken: string;
  clientId: string;
  capabilities: ClientCapabilities;
}): Promise<void> {
  const res = await cliFetch(`${opts.serverUrl}/api/v1/clients/${encodeURIComponent(opts.clientId)}/capabilities`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ capabilities: opts.capabilities }),
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on PATCH /clients/${opts.clientId}/capabilities`);
  }
}

/**
 * Replace the agent's slash-command skill list on the server. Called once per
 * managed agent during daemon startup (and on subsequent restarts) after
 * the local SKILL.md scan. Snapshot semantics: server overwrites the row
 * with the payload in full, so callers should always upload the complete
 * scan output, not a diff. Best-effort: a transient failure logs and moves
 * on; agents still bind, and a subsequent restart retries.
 */
export async function uploadAgentSkills(opts: {
  serverUrl: string;
  accessToken: string;
  agentId: string;
  skills: SkillDescriptor[];
}): Promise<void> {
  const res = await cliFetch(`${opts.serverUrl}/api/v1/agents/${encodeURIComponent(opts.agentId)}/skills`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ skills: opts.skills }),
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on PATCH /agents/${opts.agentId}/skills`);
  }
}
