import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  loadAgents,
  resolveConfigReadonly,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { findStaleAliases, formatStaleReason, type PinnedAgent, type StaleAlias } from "./agent-prune.js";
import { cliFetch } from "./cli-fetch.js";
import { blank, print } from "./output.js";
import { getClientServiceStatus } from "./service-install.js";

export type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
};

// ---------------------------------------------------------------------------
// Config resolution helpers — delegates to shared config system
// ---------------------------------------------------------------------------

function getClientConfig(): Record<string, unknown> {
  return resolveConfigReadonly({ schema: clientConfigSchema, role: "client" });
}

function get(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

export function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const [major] = version.split(".").map(Number);
  const ok = major !== undefined && major >= 22;
  return {
    label: "Node.js",
    ok,
    detail: ok ? `v${version}` : `v${version} (requires >= 22.16)`,
  };
}

// ---------------------------------------------------------------------------
// Client-specific checks
// ---------------------------------------------------------------------------

export function checkClientConfig(): CheckResult {
  const hasFile = existsSync(join(DEFAULT_CONFIG_DIR, "client.yaml"));
  const hasEnv = !!process.env.FIRST_TREE_HUB_SERVER_URL;

  if (hasFile && hasEnv) return { label: "Config", ok: true, detail: "config file + env vars" };
  if (hasFile) return { label: "Config", ok: true, detail: join(DEFAULT_CONFIG_DIR, "client.yaml") };
  if (hasEnv) return { label: "Config", ok: true, detail: "via environment variables" };
  return { label: "Config", ok: false, detail: "no config file or env vars found" };
}

export async function checkServerReachable(): Promise<CheckResult> {
  const config = getClientConfig();
  const serverUrl = get(config, "server.url");
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "Server URL", ok: false, detail: "not configured (FIRST_TREE_HUB_SERVER_URL or config file)" };
  }

  try {
    const res = await cliFetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return { label: "Server URL", ok: true, detail: serverUrl };
    }
    return { label: "Server URL", ok: false, detail: `unhealthy (HTTP ${res.status}) at ${serverUrl}` };
  } catch {
    return { label: "Server URL", ok: false, detail: `unreachable at ${serverUrl}` };
  }
}

export function checkAgentConfigs(): CheckResult {
  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  if (!existsSync(agentsDir)) {
    return {
      label: "Agents",
      ok: false,
      detail: "no agents configured",
    };
  }
  try {
    const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
    if (agents.size === 0) {
      return {
        label: "Agents",
        ok: false,
        detail: "no agents configured",
      };
    }
    const names = [...agents.keys()].join(", ");
    return { label: "Agents", ok: true, detail: `${agents.size} configured (${names})` };
  } catch {
    return { label: "Agents", ok: false, detail: "error reading agent configs" };
  }
}

/**
 * Server-aware agent reconciliation. Walks `agents/<name>/agent.yaml` and
 * cross-references each `agentId` with `/api/v1/me/pinned-agents`,
 * filtering by `clientId` so the "stale" verdict matches what R-RUN will
 * actually accept on this machine.
 *
 * Categorises each local alias into:
 *   - pinned             — bind would succeed on this client.
 *   - pinned-elsewhere   — owned by you, but pinned to a different client
 *                          (alias is dead weight here; real agent is alive
 *                          on the other machine).
 *   - unowned            — agentId not in the server's response at all.
 *   - unreadable         — yaml missing/malformed/no agentId.
 *
 * The plain `checkAgentConfigs` (sync, local-only) is retained for
 * back-compat with external consumers but its "N configured" wording is
 * misleading because stale aliases never bind at runtime.
 *
 * Skipped reconciliation (server unreachable / unauthenticated) returns
 * `ok: false` — doctor's other server-touching checks already report
 * connectivity loss as a failure, and silently passing here would hide
 * the very issue the operator is running doctor to diagnose.
 */
export async function reconcileAgentConfigs(opts: {
  clientId: string;
  listPinnedAgents: () => Promise<PinnedAgent[]>;
  /** Override for tests; defaults to `$FIRST_TREE_HUB_HOME/config/agents`. */
  agentsDir?: string;
}): Promise<CheckResult> {
  const agentsDir = opts.agentsDir ?? join(DEFAULT_CONFIG_DIR, "agents");

  // Count local alias dirs ourselves — `loadAgents` is fail-fast on
  // malformed yaml, and one bad dir would mask the entire alias set.
  let localCount = 0;
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir)) {
      try {
        if (statSync(join(agentsDir, entry)).isDirectory()) localCount++;
      } catch {
        // Vanished between readdir and stat; treat as absent.
      }
    }
  }
  if (localCount === 0) {
    return { label: "Agents", ok: false, detail: "no agents configured" };
  }

  let stale: StaleAlias[];
  try {
    stale = await findStaleAliases({
      clientId: opts.clientId,
      listPinnedAgents: opts.listPinnedAgents,
      agentsDir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      label: "Agents",
      ok: false,
      detail: `${localCount} configured locally — server reconciliation failed (${msg.slice(0, 60)})`,
    };
  }

  const pinnedCount = localCount - stale.length;

  if (stale.length === 0) {
    return {
      label: "Agents",
      ok: true,
      detail: `${localCount} configured, all pinned to this client`,
    };
  }

  const staleSummary = stale
    .map((s) => `${s.name} [${formatStaleReason(s.reason)}]`)
    .slice(0, 5)
    .join("; ");
  const truncated = stale.length > 5 ? `; ...+${stale.length - 5} more` : "";

  return {
    label: "Agents",
    ok: false,
    detail:
      `${localCount} configured locally, ${pinnedCount} pinned to this client; ` +
      `${stale.length} stale: ${staleSummary}${truncated} — ` +
      "run `first-tree-hub agent prune` to clean up",
  };
}

export function checkBackgroundService(): CheckResult {
  const info = getClientServiceStatus();
  if (info.platform === "unsupported") {
    return {
      label: "Background service",
      ok: true,
      detail: `not supported on ${process.platform} — runs inline`,
    };
  }
  if (info.state === "active") {
    return {
      label: "Background service",
      ok: true,
      detail: `running (${info.platform}${info.detail ? `, ${info.detail}` : ""}); logs at ${info.logDir}`,
    };
  }
  if (info.state === "inactive") {
    return {
      label: "Background service",
      ok: false,
      detail: `installed but not running${info.detail ? ` — ${info.detail}` : ""}; unit at ${info.unitPath}`,
    };
  }
  return {
    label: "Background service",
    ok: false,
    detail: "not installed — re-run `first-tree-hub connect <token>` to install",
  };
}

export async function checkWebSocket(): Promise<CheckResult> {
  const config = getClientConfig();
  const serverUrl = get(config, "server.url");
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "WebSocket", ok: false, detail: "cannot check (no server URL)" };
  }

  const wsUrl = serverUrl.replace(/^http/, "ws");
  try {
    const res = await cliFetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      return { label: "WebSocket", ok: true, detail: `${wsUrl} (server reachable)` };
    }
    return { label: "WebSocket", ok: false, detail: "server not healthy" };
  } catch {
    return { label: "WebSocket", ok: false, detail: `server unreachable at ${serverUrl}` };
  }
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function printResults(results: CheckResult[]): void {
  for (const r of results) {
    const icon = r.ok ? "\u2713" : "\u2717";
    print.line(`  ${icon} ${r.label.padEnd(22)} ${r.detail}\n`);
  }

  blank();

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    print.line("  All checks passed.\n");
  } else {
    print.line(`  ${failures.length} issue(s) found.\n`);
  }
  blank();
}
