import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_DIR, getClientConfig } from "@agent-team-foundation/first-tree-hub-shared/config";

const CREDENTIALS_PATH = join(DEFAULT_CONFIG_DIR, "credentials.json");

type StoredCredentials = {
  accessToken: string;
  refreshToken: string;
  serverUrl: string;
};

/**
 * Get the current GitHub username from `gh auth status`.
 */
export function getGitHubUsername(): string {
  try {
    const output = execSync("gh api /user --jq .login", { encoding: "utf-8" }).trim();
    if (!output) throw new Error("Empty response");
    return output;
  } catch {
    throw new Error(
      "Failed to get GitHub username. Ensure `gh` CLI is installed and authenticated:\n" + "  gh auth login",
    );
  }
}

/**
 * Get the GitHub auth token from `gh auth token`.
 */
export function getGitHubToken(): string {
  try {
    const output = execSync("gh auth token", { encoding: "utf-8" }).trim();
    if (!output) throw new Error("Empty response");
    return output;
  } catch {
    throw new Error(
      "Failed to get GitHub token. Ensure `gh` CLI is installed and authenticated:\n" + "  gh auth login",
    );
  }
}

/**
 * Resolve Hub server URL from flag, env, or config.
 */
export function resolveServerUrl(flagValue?: string): string {
  if (flagValue) return flagValue;
  if (process.env.FIRST_TREE_HUB_SERVER) return process.env.FIRST_TREE_HUB_SERVER;

  try {
    const config = getClientConfig();
    if (config.server?.url) return config.server.url;
  } catch {
    // Config not available
  }

  throw new Error(
    "Server URL not configured.\n" +
      "  Provide via: --server <url>, FIRST_TREE_HUB_SERVER env var, or\n" +
      "  first-tree-hub config set -c server.url <url>",
  );
}

/**
 * Bootstrap a token for an agent using GitHub identity.
 */
export async function bootstrapToken(
  serverUrl: string,
  agentName: string,
  options: {
    saveTo?: string;
    type?: string;
    displayName?: string;
    delegateMention?: string;
    profile?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<{ token: string; agentId: string }> {
  const githubToken = getGitHubToken();

  const body: Record<string, unknown> = { name: "bootstrap" };
  if (options.type) body.type = options.type;
  if (options.displayName) body.displayName = options.displayName;
  if (options.delegateMention) body.delegateMention = options.delegateMention;
  if (options.profile) body.profile = options.profile;
  if (options.metadata) body.metadata = options.metadata;

  const res = await fetch(`${serverUrl}/api/v1/bootstrap/${encodeURIComponent(agentName)}/token`, {
    method: "POST",
    headers: {
      "X-GitHub-Token": githubToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const msg = body.error ?? `HTTP ${res.status}`;
    throw new Error(`Bootstrap failed for "${agentName}": ${msg}`);
  }

  const data = (await res.json()) as { token: string; agentId: string };

  // Save token to agent config if requested
  if (options.saveTo === "agent" || !options.saveTo) {
    const configDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
    const configPath = `${configDir}/agent.yaml`;
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, `token: "${data.token}"\ntype: claude-code\n`, { mode: 0o600 });
    chmodSync(configDir, 0o700);
  } else if (options.saveTo) {
    mkdirSync(dirname(options.saveTo), { recursive: true });
    writeFileSync(options.saveTo, data.token, { mode: 0o600 });
  }

  return data;
}

/**
 * Resolve agent token from FIRST_TREE_HUB_TOKEN env var.
 * Throws if not set.
 */
export function resolveAgentToken(): string {
  const token = process.env.FIRST_TREE_HUB_TOKEN;
  if (!token) {
    throw new Error("FIRST_TREE_HUB_TOKEN environment variable is required.");
  }
  return token;
}

/**
 * Resolve admin JWT token from FIRST_TREE_HUB_ADMIN_TOKEN env var
 * or persisted credentials from `connect` command.
 * Auto-refreshes expired access tokens when a refresh token is available.
 * Throws if neither is available.
 */
export function resolveAdminToken(): string {
  const envToken = process.env.FIRST_TREE_HUB_ADMIN_TOKEN;
  if (envToken) return envToken;

  // Fall back to persisted credentials from `connect`
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "No credentials found.\n" +
        "  Run: first-tree-hub connect <server-url>\n" +
        "  Or set FIRST_TREE_HUB_ADMIN_TOKEN environment variable.",
    );
  }

  // Check if the access token is expired (JWT payload is base64url-encoded)
  if (isTokenExpired(creds.accessToken)) {
    // Return the stored token as-is; the async refresh will happen lazily
    // To avoid making this function async (breaking many call sites),
    // callers get the possibly-expired token — but we schedule a sync refresh
    // via the refreshCredentials() helper that can be awaited at the call site.
    return creds.accessToken;
  }

  return creds.accessToken;
}

/**
 * Ensure the persisted access token is fresh. Call before any admin API request
 * when using persisted credentials. Returns the (possibly refreshed) access token.
 */
export async function ensureFreshAdminToken(): Promise<string> {
  const envToken = process.env.FIRST_TREE_HUB_ADMIN_TOKEN;
  if (envToken) return envToken;

  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "No credentials found.\n" +
        "  Run: first-tree-hub connect <server-url>\n" +
        "  Or set FIRST_TREE_HUB_ADMIN_TOKEN environment variable.",
    );
  }

  if (!isTokenExpired(creds.accessToken)) {
    return creds.accessToken;
  }

  // Refresh the access token using the refresh token
  const res = await fetch(`${creds.serverUrl}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: creds.refreshToken }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error("Access token expired and refresh failed.\n" + "  Run: first-tree-hub connect <server-url>");
  }

  const data = (await res.json()) as { accessToken: string };
  saveCredentials({ ...creds, accessToken: data.accessToken });
  return data.accessToken;
}

/** Check if a JWT access token is expired (with 30s margin). */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now() - 30_000;
  } catch {
    return true;
  }
}

/** Persist credentials to disk. */
function saveCredentials(creds: StoredCredentials): void {
  const dir = dirname(CREDENTIALS_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Load persisted credentials saved by `connect` command.
 */
export function loadCredentials(): StoredCredentials | null {
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as unknown;
    const data = raw as StoredCredentials;
    if (data.accessToken && data.refreshToken && data.serverUrl) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if an agent exists and is synced.
 */
export async function checkBootstrapStatus(
  serverUrl: string,
  agentName: string,
): Promise<{ exists: boolean; status: string | null }> {
  const githubToken = getGitHubToken();

  const res = await fetch(`${serverUrl}/api/v1/bootstrap/${encodeURIComponent(agentName)}/status`, {
    headers: { "X-GitHub-Token": githubToken },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return (await res.json()) as { exists: boolean; status: string | null };
}

/**
 * Write agent config (token + runtime) to disk.
 * Used by `agent create`, `agent add`, bootstrap, and server-pushed provisioning.
 */
export function saveAgentConfig(agentName: string, token: string, runtime: string): string {
  const agentDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "agent.yaml"), `token: "${token}"\nruntime: ${runtime}\n`, { mode: 0o600 });
  return agentDir;
}

/** Mask a token for display: show first 6 + last 2 chars. */
export function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 6)}***${token.slice(-2)}` : "***";
}
