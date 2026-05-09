import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClientCapabilities,
  LocalGitRepoSummaries,
  RuntimeProvider,
} from "@agent-team-foundation/first-tree-hub-shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type LogFn = (level: "info" | "warn", msg: string) => void;

type AuthoritativePinnedAgent = {
  agentId: string;
  clientId: string;
  runtimeProvider: RuntimeProvider;
};

/**
 * Pre-flight reconciliation called before the agents loop spawns. Pulls
 * authoritative `runtime_provider` for every agent the calling user owns and
 * rewrites any local `agent.yaml` whose `runtime` field disagrees. Best-
 * effort: a transient hub failure logs and falls back to the local YAML
 * value (the in-band repair path catches any remaining drift on first bind).
 */
export async function reconcileLocalRuntimeProviders(opts: {
  serverUrl: string;
  accessToken: string;
  agentsDir: string;
  log?: LogFn;
}): Promise<void> {
  const res = await fetch(`${opts.serverUrl}/api/v1/me/pinned-agents`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`hub returned ${res.status} on /clients/me/agents`);
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
        `agent ${parsed.agentId}: yaml runtime "${parsed.runtime ?? "(unset)"}" → "${auth.runtimeProvider}" (hub authoritative)`,
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
 *
 * `localGitRepos` is an optional snapshot of the host's working clones —
 * see `probeLocalGitRepos` in `@first-tree-hub/client`. When present, the
 * server stores it under `clients.metadata.localGitRepos` so the Hub's
 * Step 3 onboarding picker can offer "pick from your local repos".
 */
export async function uploadClientCapabilities(opts: {
  serverUrl: string;
  accessToken: string;
  clientId: string;
  capabilities: ClientCapabilities;
  localGitRepos?: LocalGitRepoSummaries;
}): Promise<void> {
  const body: Record<string, unknown> = { capabilities: opts.capabilities };
  if (opts.localGitRepos) body.localGitRepos = opts.localGitRepos;
  const res = await fetch(`${opts.serverUrl}/api/v1/clients/${encodeURIComponent(opts.clientId)}/capabilities`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`hub returned ${res.status} on PATCH /clients/${opts.clientId}/capabilities`);
  }
}
