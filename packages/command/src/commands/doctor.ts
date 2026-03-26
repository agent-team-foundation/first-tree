import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentConfigSchema, DEFAULT_CONFIG_DIR, loadAgents, readConfigFile } from "@agent-hub/shared/config";
import { blank } from "../cli/output.js";

export type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
};

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
  const configPath = join(DEFAULT_CONFIG_DIR, "server.yaml");
  const exists = existsSync(configPath);
  return {
    label: "Config",
    ok: exists,
    detail: exists ? configPath : "not found — run: agent-hub config setup -s",
  };
}

export async function checkDatabase(): Promise<CheckResult> {
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const dbUrl = getNestedValue(serverConfig, "database.url");
  if (typeof dbUrl !== "string" || !dbUrl) {
    return { label: "Database", ok: false, detail: "no database URL configured" };
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
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const token = getNestedValue(serverConfig, "github.token") ?? process.env.AGENT_HUB_GITHUB_TOKEN;
  if (typeof token !== "string" || !token) {
    return { label: "GitHub Token", ok: false, detail: "not configured" };
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
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const repo = getNestedValue(serverConfig, "contextTree.repo");
  const token = getNestedValue(serverConfig, "github.token") ?? process.env.AGENT_HUB_GITHUB_TOKEN;

  if (typeof repo !== "string" || !repo) {
    return { label: "Context Tree", ok: false, detail: "not configured" };
  }
  if (typeof token !== "string" || !token) {
    return { label: "Context Tree", ok: false, detail: "cannot check (no GitHub token)" };
  }

  // Normalize repo: extract owner/repo from URL if needed
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

export async function checkPort(): Promise<CheckResult> {
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const port = (getNestedValue(serverConfig, "server.port") as number) ?? 8000;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      return { label: `Port ${port}`, ok: true, detail: "in use by Agent Hub" };
    }
    return { label: `Port ${port}`, ok: false, detail: "in use by another process" };
  } catch {
    return { label: `Port ${port}`, ok: true, detail: "available" };
  }
}

// ---------------------------------------------------------------------------
// Client-specific checks
// ---------------------------------------------------------------------------

export function checkClientConfig(): CheckResult {
  const configPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
  const exists = existsSync(configPath);
  return {
    label: "Config",
    ok: exists,
    detail: exists ? configPath : "not found — run: agent-hub config setup -c",
  };
}

export async function checkServerReachable(): Promise<CheckResult> {
  const clientConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "client.yaml"));
  const serverUrl = getNestedValue(clientConfig, "server.url") ?? process.env.AGENT_HUB_SERVER_URL;
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "Server URL", ok: false, detail: "not configured" };
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
      detail: "no agents configured — run: agent-hub client add <name> --token <token>",
    };
  }
  try {
    const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
    if (agents.size === 0) {
      return {
        label: "Agents",
        ok: false,
        detail: "no agents configured — run: agent-hub client add <name> --token <token>",
      };
    }
    const names = [...agents.keys()].join(", ");
    return { label: "Agents", ok: true, detail: `${agents.size} configured (${names})` };
  } catch {
    return { label: "Agents", ok: false, detail: "error reading agent configs" };
  }
}

export async function checkAgentTokens(): Promise<CheckResult> {
  const clientConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "client.yaml"));
  const serverUrl = getNestedValue(clientConfig, "server.url") ?? process.env.AGENT_HUB_SERVER_URL;
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

  for (const [name, config] of agents) {
    try {
      const res = await fetch(`${serverUrl}/api/v1/agent/me`, {
        headers: { Authorization: `Bearer ${config.token}` },
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
  const clientConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "client.yaml"));
  const serverUrl = getNestedValue(clientConfig, "server.url") ?? process.env.AGENT_HUB_SERVER_URL;
  if (typeof serverUrl !== "string" || !serverUrl) {
    return { label: "WebSocket", ok: false, detail: "cannot check (no server URL)" };
  }

  // Just verify the WS upgrade endpoint exists by checking the server is reachable
  // Full WS connection requires a valid token, so we only check reachability
  const wsUrl = serverUrl.replace(/^http/, "ws");
  try {
    // We use HTTP to check the base URL; actual WS test would require auth
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

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
