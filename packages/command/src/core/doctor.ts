import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  loadAgents,
  resolveConfigReadonly,
  serverConfigSchema,
} from "@first-tree-hub/shared/config";
import { blank } from "./output.js";

export type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
};

// ---------------------------------------------------------------------------
// Config resolution helpers — delegates to shared config system
// ---------------------------------------------------------------------------

function getServerConfig(): Record<string, unknown> {
  return resolveConfigReadonly({ schema: serverConfigSchema, role: "server" });
}

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
// Server-specific checks
// ---------------------------------------------------------------------------

export function checkDocker(): CheckResult {
  try {
    const output = execFileSync("docker", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
    return { label: "Docker", ok: true, detail: output.replace("Docker version ", "v").split(",")[0] ?? "" };
  } catch {
    return { label: "Docker", ok: false, detail: "not found (optional — needed for auto PG provisioning)" };
  }
}

export function checkServerConfig(): CheckResult {
  const hasFile = existsSync(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  // Check if key required env vars are set
  const hasEnv = !!(
    process.env.FIRST_TREE_HUB_DATABASE_URL ||
    process.env.FIRST_TREE_HUB_CONTEXT_TREE_REPO ||
    process.env.FIRST_TREE_HUB_GITHUB_TOKEN
  );

  if (hasFile && hasEnv) return { label: "Config", ok: true, detail: "config file + env vars" };
  if (hasFile) return { label: "Config", ok: true, detail: join(DEFAULT_CONFIG_DIR, "server.yaml") };
  if (hasEnv) return { label: "Config", ok: true, detail: "via environment variables" };
  return { label: "Config", ok: false, detail: "no config file or env vars found" };
}

export async function checkDatabase(): Promise<CheckResult> {
  const config = getServerConfig();
  const dbUrl = get(config, "database.url");
  if (typeof dbUrl !== "string" || !dbUrl) {
    return { label: "Database", ok: false, detail: "not configured (FIRST_TREE_HUB_DATABASE_URL or config file)" };
  }

  try {
    const { default: pg } = (await import("postgres")) as { default: (url: string, opts: unknown) => unknown };
    const sql = pg(dbUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 }) as {
      unsafe: (q: string) => Promise<unknown>;
      end: () => Promise<void>;
    };
    await sql.unsafe("SELECT 1");
    await sql.end();
    return { label: "Database", ok: true, detail: "connected" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label: "Database", ok: false, detail: `unreachable — ${msg.slice(0, 80)}` };
  }
}

export async function checkGitHubToken(): Promise<CheckResult> {
  const config = getServerConfig();
  const token = get(config, "github.token");
  if (typeof token !== "string" || !token) {
    return { label: "GitHub Token", ok: false, detail: "not configured (FIRST_TREE_HUB_GITHUB_TOKEN or config file)" };
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { login?: string };
      return { label: "GitHub Token", ok: true, detail: `valid (${data.login})` };
    }
    return { label: "GitHub Token", ok: false, detail: `invalid (HTTP ${res.status})` };
  } catch {
    return { label: "GitHub Token", ok: false, detail: "could not reach api.github.com" };
  }
}

export async function checkContextTreeRepo(): Promise<CheckResult> {
  const config = getServerConfig();
  const repo = get(config, "contextTree.repo");
  const token = get(config, "github.token");

  if (typeof repo !== "string" || !repo) {
    return {
      label: "Context Tree",
      ok: false,
      detail: "not configured (FIRST_TREE_HUB_CONTEXT_TREE_REPO or config file)",
    };
  }
  if (typeof token !== "string" || !token) {
    return { label: "Context Tree", ok: false, detail: "cannot check (no GitHub token)" };
  }

  const ownerRepo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");

  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { label: "Context Tree", ok: true, detail: ownerRepo };
    }
    return { label: "Context Tree", ok: false, detail: `inaccessible (HTTP ${res.status})` };
  } catch {
    return { label: "Context Tree", ok: false, detail: "could not reach api.github.com" };
  }
}

export async function checkServerHealth(): Promise<CheckResult> {
  const config = getServerConfig();
  const host = (get(config, "server.host") as string) ?? "127.0.0.1";
  const port = (get(config, "server.port") as number) ?? 8000;
  const url = `http://${host}:${port}/healthz`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      return { label: "Server Health", ok: true, detail: `running at ${host}:${port}` };
    }
    return { label: "Server Health", ok: false, detail: `unhealthy (HTTP ${res.status}) at ${host}:${port}` };
  } catch {
    return { label: "Server Health", ok: false, detail: `not running at ${host}:${port}` };
  }
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
    const res = await fetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
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

export async function checkAgentTokens(): Promise<CheckResult> {
  const config = getClientConfig();
  const serverUrl = get(config, "server.url");
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "Agent Tokens", ok: false, detail: "cannot check (no server URL)" };
  }

  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  if (!existsSync(agentsDir)) {
    return { label: "Agent Tokens", ok: false, detail: "no agents to check" };
  }

  let agents: Map<string, { token: string }>;
  try {
    agents = loadAgents({ schema: agentConfigSchema, agentsDir }) as Map<string, { token: string }>;
  } catch {
    return { label: "Agent Tokens", ok: false, detail: "error reading agent configs" };
  }

  if (agents.size === 0) {
    return { label: "Agent Tokens", ok: false, detail: "no agents to check" };
  }

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const [name, agentConfig] of agents) {
    try {
      const res = await fetch(`${serverUrl}/api/v1/agent/me`, {
        headers: { Authorization: `Bearer ${agentConfig.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        valid.push(name);
      } else {
        invalid.push(name);
      }
    } catch {
      invalid.push(name);
    }
  }

  if (invalid.length === 0) {
    return { label: "Agent Tokens", ok: true, detail: `all ${valid.length} valid` };
  }
  return { label: "Agent Tokens", ok: false, detail: `invalid: ${invalid.join(", ")}` };
}

export async function checkWebSocket(): Promise<CheckResult> {
  const config = getClientConfig();
  const serverUrl = get(config, "server.url");
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "WebSocket", ok: false, detail: "cannot check (no server URL)" };
  }

  const wsUrl = serverUrl.replace(/^http/, "ws");
  try {
    const res = await fetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
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
    process.stderr.write(`  ${icon} ${r.label.padEnd(22)} ${r.detail}\n`);
  }

  blank();

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    process.stderr.write("  All checks passed.\n");
  } else {
    process.stderr.write(`  ${failures.length} issue(s) found.\n`);
  }
  blank();
}
