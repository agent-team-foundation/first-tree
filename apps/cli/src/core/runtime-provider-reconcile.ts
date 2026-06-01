import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientCapabilities, RuntimeProvider, SkillDescriptor } from "@first-tree/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { cliFetch } from "./cli-fetch.js";

type LogFn = (level: "info" | "warn", msg: string) => void;

type AuthoritativePinnedAgent = {
  agentId: string;
  clientId: string;
  runtimeProvider: RuntimeProvider;
  status?: string;
};

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
  const res = await cliFetch(`${opts.serverUrl}/api/v1/me/pinned-agents`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on /clients/me/agents`);
  }
  const items = (await res.json()) as AuthoritativePinnedAgent[];
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
