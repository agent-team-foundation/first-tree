import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientConfigSchema, DEFAULT_CONFIG_DIR, resolveConfigReadonly } from "@first-tree/shared/config";
import { cliFetch } from "./cli-fetch.js";

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
      "  first-tree-hub client config set server.url <url>",
  );
}

/**
 * Resolve the current member access JWT from persisted credentials.
 *
 * Unified-user-token milestone: the CLI has a single credential store and a
 * single onboarding path (`first-tree-hub connect <token>`). The legacy
 * `FIRST_TREE_HUB_TOKEN` env var is no longer read — callers get a clear
 * error pointing at `connect <token>` instead.
 */
export function resolveAccessToken(): string {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error("No credentials found. Run `first-tree-hub connect <token>` to sign in.");
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
 * Thrown when `/auth/refresh` returns 429. Carries the server-suggested
 * retry-after (or a sane default) so the WS reconnect loop can wait at
 * least that long instead of pounding the limiter inside the same window
 * with its default 1/2/4/8s exponential backoff — which would just keep
 * the rate-limit bucket full and stretch the outage. Defaults to 30s when
 * the server omits the header.
 */
export class AuthRefreshRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message?: string) {
    super(message ?? `Refresh request rate-limited; retry after ${Math.round(retryAfterMs / 1000)}s.`);
    this.name = "AuthRefreshRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse an HTTP `Retry-After` header. Accepts either an integer seconds
 * value (the form fastify-rate-limit emits) or an RFC 7231 HTTP-date.
 * Returns ms, or `null` when the header is absent / malformed.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
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
    throw new Error("No credentials found. Run `first-tree-hub connect <token>` to sign in.");
  }

  if (!isTokenStale(creds.accessToken, minValidityMs)) {
    return creds.accessToken;
  }

  if (inflightRefresh) {
    return inflightRefresh;
  }

  inflightRefresh = (async () => {
    const res = await cliFetch(`${creds.serverUrl}/api/v1/auth/refresh`, {
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
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 30_000;
      throw new AuthRefreshRateLimitedError(retryAfterMs);
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

/**
 * Persist credentials to disk atomically.
 *
 * Plain `writeFileSync` opens with `O_TRUNC` then writes — between those
 * calls the file is empty, and a concurrent `loadCredentials()` (e.g. a
 * background daemon refreshing while the user runs a foreground CLI command)
 * reads "" → `JSON.parse` throws → we fall back to "no credentials" and
 * surface a misleading "run `connect <token>` again" error. write-to-temp +
 * rename gives readers an all-or-nothing view: they see the old file or the
 * new file, never a half-written one. Server-side the sliding-window design
 * already accepts last-writer-wins semantics for the refresh token itself
 * (see auth service comment), so atomicity at the file level is enough.
 */
export function saveCredentials(creds: StoredCredentials): void {
  const dir = dirname(CREDENTIALS_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${CREDENTIALS_PATH}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    renameSync(tmp, CREDENTIALS_PATH);
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leave behind orphan
    // temp files. Swallow the unlink error — the original failure is what
    // the caller cares about.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
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
