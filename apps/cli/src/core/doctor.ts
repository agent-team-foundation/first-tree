import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityEntry } from "@first-tree/shared";
import {
  agentConfigSchema,
  clientConfigSchema,
  defaultConfigDir,
  loadAgents,
  resolveConfigReadonly,
} from "@first-tree/shared/config";
import { parse as parseYaml } from "yaml";
import { findStaleAliases, formatStaleReason, type PinnedAgent, type StaleAlias } from "./agent-prune.js";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";
import { blank, print } from "./output.js";
import {
  LEGACY_GITHUB_SCAN_LABEL_PREFIX,
  legacyGithubScanLaunchdDir,
  scanLegacyGithubScanPlists,
} from "./retire-github-scan-launchd.js";
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
  const [major, minor] = version.split(".").map(Number);
  // Floor of `>=22.13.0` matches engines.node on the published packages
  // and reflects the real strict-resolver floor — `@inquirer/prompts`
  // (a direct dep of apps/cli) is the tightest constraint at `^22.13.0`,
  // so under pnpm / yarn / `engine-strict=true` installs on 22.0-22.12
  // hard-fail despite engines saying otherwise. Mirror that here so the
  // doctor is honest about the supported range, not just the major.
  const ok = major !== undefined && (major >= 23 || (major === 22 && minor !== undefined && minor >= 13));
  return {
    label: "Node.js",
    ok,
    detail: ok ? `v${version}` : `v${version} (requires >= 22.13)`,
  };
}

// ---------------------------------------------------------------------------
// Client-specific checks
// ---------------------------------------------------------------------------

export function checkClientConfig(): CheckResult {
  const hasFile = existsSync(join(defaultConfigDir(), "client.yaml"));
  const hasEnv = !!process.env.FIRST_TREE_SERVER_URL;

  if (hasFile && hasEnv) return { label: "Config", ok: true, detail: "config file + env vars" };
  if (hasFile) return { label: "Config", ok: true, detail: join(defaultConfigDir(), "client.yaml") };
  if (hasEnv) return { label: "Config", ok: true, detail: "via environment variables" };
  return { label: "Config", ok: false, detail: "no config file or env vars found" };
}

export async function checkServerReachable(): Promise<CheckResult> {
  const config = getClientConfig();
  const serverUrl = get(config, "server.url");
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "Server URL", ok: false, detail: "not configured (FIRST_TREE_SERVER_URL or config file)" };
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
  const agentsDir = join(defaultConfigDir(), "agents");
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

function countSuspendedLocalAliases(agentsDir: string, suspendedAgentIds: ReadonlySet<string>): number {
  if (suspendedAgentIds.size === 0 || !existsSync(agentsDir)) return 0;

  let count = 0;
  for (const entry of readdirSync(agentsDir)) {
    const yamlPath = join(agentsDir, entry, "agent.yaml");
    if (!existsSync(yamlPath)) continue;
    try {
      const raw = parseYaml(readFileSync(yamlPath, "utf-8"));
      if (raw === null || typeof raw !== "object") continue;
      const agentId = (raw as Record<string, unknown>).agentId;
      if (typeof agentId === "string" && suspendedAgentIds.has(agentId)) count++;
    } catch {
      // Malformed aliases are reported by findStaleAliases as unreadable.
    }
  }
  return count;
}

/**
 * Server-aware agent reconciliation. Walks `agents/<name>/agent.yaml` and
 * cross-references each `agentId` with `/api/v1/me/pinned-agents`,
 * filtering by `clientId` so the "stale" verdict matches what R-RUN will
 * actually accept on this machine.
 *
 * Categorises each local alias into:
 *   - pinned             — owned by you and assigned to this client.
 *   - suspended          — pinned to this client but disabled; retained
 *                          locally and skipped at runtime until reactivated.
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
  /** Override for tests; defaults to `$FIRST_TREE_HOME/config/agents`. */
  agentsDir?: string;
}): Promise<CheckResult> {
  const agentsDir = opts.agentsDir ?? join(defaultConfigDir(), "agents");

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
  let remote: PinnedAgent[];
  try {
    remote = await opts.listPinnedAgents();
    stale = await findStaleAliases({
      clientId: opts.clientId,
      listPinnedAgents: async () => remote,
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
  const suspendedAgentIds = new Set(
    remote.filter((r) => r.clientId === opts.clientId && r.status === "suspended").map((r) => r.agentId),
  );
  const suspendedLocalCount = countSuspendedLocalAliases(agentsDir, suspendedAgentIds);
  const activePinnedCount = pinnedCount - suspendedLocalCount;

  if (stale.length === 0) {
    return {
      label: "Agents",
      ok: true,
      detail:
        suspendedLocalCount > 0
          ? `${localCount} configured, ${activePinnedCount} active and ${suspendedLocalCount} suspended/disabled on this client`
          : `${localCount} configured, all pinned to this client`,
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
      `${localCount} configured locally, ${activePinnedCount} active` +
      `${suspendedLocalCount > 0 ? `, ${suspendedLocalCount} suspended/disabled` : ""}; ` +
      `${stale.length} stale: ${staleSummary}${truncated} — ` +
      `run \`${channelConfig.binName} agent prune\` to clean up`,
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
  if (info.state === "unknown") {
    return {
      label: "Background service",
      ok: false,
      detail: `state unknown (${info.platform}${info.detail ? `, ${info.detail}` : ""}); unit at ${info.unitPath}`,
    };
  }
  return {
    label: "Background service",
    ok: false,
    detail: `not installed — re-run \`${channelConfig.binName} login <code>\` to install`,
  };
}

/**
 * Read-only residue scan for the retired legacy `github-scan` launchd runner.
 * Complements the automatic startup sweep in two ways the sweep deliberately
 * leaves out: a `launchctl list` prefix scan catches session zombies whose
 * plist was hand-deleted or lives under a custom `$GITHUB_SCAN_HOME` /
 * `$GITHUB_SCAN_DIR` directory the disk sweep never enumerates, and foreign
 * plists the sweep skipped are surfaced instead of staying silent. Detection
 * only — cleanup belongs to the automatic sweep or the printed manual command.
 */
export function checkLegacyGithubScanRunner(): CheckResult {
  const label = "Legacy github-scan";
  if (process.platform !== "darwin") {
    return { label, ok: true, detail: `not applicable on ${process.platform}` };
  }

  const { legacyLabels, foreignPlists } = scanLegacyGithubScanPlists();

  let loadedLabels: string[] | null = null;
  try {
    const result = spawnSync("launchctl", ["list"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      // `launchctl list` rows are "PID\tStatus\tLabel"; the header row and
      // non-matching labels fall out of the prefix filter.
      loadedLabels = result.stdout
        .split("\n")
        .map((line) => line.split("\t").at(-1)?.trim() ?? "")
        .filter((entry) => entry.startsWith(LEGACY_GITHUB_SCAN_LABEL_PREFIX));
    }
  } catch {
    // launchctl unavailable — the disk verdict below still stands.
  }

  const stranded = [...new Set([...legacyLabels, ...(loadedLabels ?? [])])];
  if (stranded.length > 0) {
    const sample = stranded.slice(0, 2).join(", ");
    const suffix = stranded.length > 2 ? ` +${stranded.length - 2} more` : "";
    return {
      label,
      ok: false,
      detail:
        `stranded legacy runner (${sample}${suffix}) — any CLI command retries the automatic cleanup ` +
        "after its cooldown, or run `launchctl bootout gui/$(id -u)/<label>` now",
    };
  }

  const notes = ["no stranded runner"];
  if (foreignPlists.length > 0) {
    notes.push(`${foreignPlists.length} unrelated plist(s) under ${legacyGithubScanLaunchdDir()} left untouched`);
  }
  if (loadedLabels === null) notes.push("launchctl scan unavailable");
  return { label, ok: true, detail: notes.join("; ") };
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
// Runtime-provider capability rendering (shared by `daemon doctor` and
// `daemon probe`)
// ---------------------------------------------------------------------------

const RUNTIME_PROVIDER_ORDER = ["claude-code", "claude-code-tui", "codex", "cursor", "kimi-code"];

function formatCapabilityDetail(entry: CapabilityEntry): string {
  if (entry.state === "ok") {
    // Install-only detection: `ok` means the runtime binary is installed, not
    // that it is authenticated or end-to-end usable (that is discovered at
    // session run time). Show the resolved artifact provenance, not auth.
    const bits: string[] = ["installed"];
    if (entry.runtimeSource) bits.push(entry.runtimeSource);
    if (entry.sdkVersion) bits.push(`v${entry.sdkVersion}`);
    if (typeof entry.latencyMs === "number") bits.push(`${entry.latencyMs}ms`);
    return `ok — ${bits.join(", ")}`;
  }
  // `missing` / `error` carry the resolver's own reason — surface it verbatim.
  const reason = entry.error?.trim();
  return reason ? `${entry.state} — ${reason}` : entry.state;
}

/**
 * Render one capability entry as a doctor CheckResult. `ok` ⟺ the install-only
 * probe resolved the runtime binary (installed); authentication and usability
 * are not probed (they surface at session run time).
 */
export function runtimeProviderCheck(provider: string, entry: CapabilityEntry): CheckResult {
  return { label: provider, ok: entry.state === "ok", detail: formatCapabilityDetail(entry) };
}

/**
 * Map a capabilities snapshot into doctor CheckResults, ordered built-ins
 * first then any unknown providers alphabetically. Empty snapshot → a single
 * not-ok row so the operator sees the section ran but found nothing.
 */
export function runtimeProviderChecks(capabilities: Record<string, CapabilityEntry | undefined>): CheckResult[] {
  const rank = (provider: string): number => {
    const i = RUNTIME_PROVIDER_ORDER.indexOf(provider);
    return i === -1 ? RUNTIME_PROVIDER_ORDER.length : i;
  };
  const entries = Object.entries(capabilities).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  if (entries.length === 0) {
    return [{ label: "Runtime providers", ok: false, detail: "no providers probed" }];
  }
  return entries.flatMap(([provider, entry]) => (entry ? [runtimeProviderCheck(provider, entry)] : []));
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
