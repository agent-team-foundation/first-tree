import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  resolveConfigReadonly,
} from "@agent-team-foundation/first-tree-hub-shared/config";

const CREDENTIALS_PATH = join(DEFAULT_CONFIG_DIR, "credentials.json");

type StoredCredentials = {
  accessToken: string;
  refreshToken: string;
  serverUrl: string;
};

/**
 * Resolve Hub server URL from flag, env, or config.
 *
 * Uses resolveConfigReadonly (not the singleton getClientConfig) so CLI entry
 * points don't have to remember to call initConfig() first.
 */
export function resolveServerUrl(flagValue?: string): string {
  if (flagValue) return flagValue;
  if (process.env.FIRST_TREE_HUB_SERVER_URL) return process.env.FIRST_TREE_HUB_SERVER_URL;

  const config = resolveConfigReadonly({ schema: clientConfigSchema, role: "client" });
  const server = config.server;
  if (server !== null && typeof server === "object") {
    const url = Reflect.get(server, "url");
    if (typeof url === "string" && url.length > 0) return url;
  }

  throw new Error(
    "Server URL not configured.\n" +
      "  Provide via: --server <url>, FIRST_TREE_HUB_SERVER_URL env var, or\n" +
      "  first-tree-hub config set -c server.url <url>",
  );
}

/**
 * Resolve the current member access JWT from persisted credentials.
 *
 * Unified-user-token milestone: the CLI has a single credential store and a
 * single onboarding path (`first-tree-hub client connect`). The legacy
 * `FIRST_TREE_HUB_TOKEN` env var is no longer read — callers get a clear
 * error pointing at `client connect` instead.
 */
export function resolveAccessToken(): string {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error("No credentials found. Run `first-tree-hub client connect <server-url>` to sign in.");
  }
  return creds.accessToken;
}

/**
 * Thrown when `/auth/refresh` returns 401 — i.e. the persisted refresh
 * token has expired or been revoked, so no amount of retrying will get
 * us back online without operator action. Callers (the WS reconnect
 * loop in particular) catch this distinctly from generic network/HTTP
 * errors so they can stop the 1Hz reconnect-and-fail thrash and ask
 * systemd/launchd to back off.
 */
export class AuthRefreshFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRefreshFailedError";
  }
}

/**
 * In-flight refresh promise. Multiple callers (WS handshake, proactive
 * refresh timer, every SDK request) can see an expired token within the same
 * millisecond — without dedupe each would fire an independent `/auth/refresh`
 * round-trip and race to write `credentials.json`. Share one in-flight
 * promise so N concurrent callers resolve from a single HTTP call.
 */
let inflightRefresh: Promise<string> | null = null;

/** Default freshness window for HTTP callers: refresh if token expires within 30s. */
const DEFAULT_MIN_VALIDITY_MS = 30_000;

/**
 * Ensure the persisted access token is fresh. Call before any API request
 * when using persisted credentials. Returns the (possibly refreshed) access
 * token. Service-user API keys are out of scope for this milestone.
 *
 * `opts.minValidityMs` raises the freshness bar — refresh when the cached
 * token has less than that much life left. The WS proactive-refresh path
 * passes a value that overlaps its lead window so it never receives a
 * token already inside the "about to expire" zone.
 *
 * Sliding-window note: the server now rotates the refresh token on every
 * successful `/auth/refresh`. We persist the rotated token alongside the
 * new access token so an actively-used client never hits the absolute
 * `refreshTokenExpiry` ceiling. If the response omits `refreshToken`
 * (i.e. an older server) we keep the existing one — the cost is just
 * losing the sliding behaviour against that backend, not a correctness
 * regression.
 */
export async function ensureFreshAccessToken(opts?: { minValidityMs?: number }): Promise<string> {
  const minValidityMs = opts?.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS;
  const creds = loadCredentials();
  if (!creds) {
    throw new Error("No credentials found. Run `first-tree-hub client connect <server-url>` to sign in.");
  }

  if (!isTokenStale(creds.accessToken, minValidityMs)) {
    return creds.accessToken;
  }

  if (inflightRefresh) {
    return inflightRefresh;
  }

  inflightRefresh = (async () => {
    const res = await fetch(`${creds.serverUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: creds.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      throw new AuthRefreshFailedError(
        "Refresh token rejected by server. Re-run `first-tree-hub connect <token>` " +
          "(get a fresh token from the Web Computers page → New Connection).",
      );
    }
    if (!res.ok) {
      throw new Error(`Refresh request failed with status ${res.status}.`);
    }

    const data = (await res.json()) as { accessToken: string; refreshToken?: string };
    saveCredentials({
      ...creds,
      accessToken: data.accessToken,
      // Older servers won't echo a rotated refreshToken back — keep the existing one.
      refreshToken: data.refreshToken ?? creds.refreshToken,
    });
    return data.accessToken;
  })();

  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

/** Back-compat alias retained so existing call sites keep compiling. */
export const ensureFreshAdminToken = ensureFreshAccessToken;

function isTokenStale(token: string, minValidityMs: number): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now() + minValidityMs;
  } catch {
    return true;
  }
}

/** Persist credentials to disk. */
export function saveCredentials(creds: StoredCredentials): void {
  const dir = dirname(CREDENTIALS_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Load persisted credentials saved by the `connect` command.
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
 * Write agent config (agentId + runtime) to disk.
 */
export function saveAgentConfig(agentName: string, agentId: string, runtime: string): string {
  const agentDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "agent.yaml"), `agentId: "${agentId}"\nruntime: ${runtime}\n`, { mode: 0o600 });
  return agentDir;
}

/** Mask a JWT/token for display: show first 6 + last 2 chars. */
export function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 6)}***${token.slice(-2)}` : "***";
}
