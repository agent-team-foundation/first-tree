import { loadCredentials, saveCredentials } from "./bootstrap.js";

type Tokens = { accessToken: string; refreshToken: string; serverUrl: string };

const REFRESH_LEEWAY_MS = 30_000;

/** Decode a JWT payload without signature verification. */
function decodeExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function isExpired(token: string): boolean {
  const exp = decodeExp(token);
  if (exp === null) return true;
  return exp * 1000 < Date.now() + REFRESH_LEEWAY_MS;
}

async function tryRefresh(creds: Tokens): Promise<Tokens | null> {
  try {
    const res = await fetch(`${creds.serverUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: creds.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken: string; refreshToken?: string };
    return {
      ...creds,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? creds.refreshToken,
    };
  } catch {
    return null;
  }
}

async function tryLocalBootstrap(serverUrl: string): Promise<Tokens | null> {
  try {
    const res = await fetch(`${serverUrl}/api/v1/auth/local-bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    return { accessToken: data.accessToken, refreshToken: data.refreshToken, serverUrl };
  } catch {
    return null;
  }
}

/**
 * Loopback-only origins the daemon trusts for refresh-token replay. Without
 * this guard, a cached refresh token could be sent to whatever origin
 * happens to be in `credentials.json` — including an attacker who briefly
 * commandeered the same port. The loopback restriction is consistent with
 * the design's local-mode trust boundary (Q7).
 */
function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Node's URL parser returns IPv6 hostnames bracketed (`[::1]`); the bare
    // form arrives only when the caller already stripped brackets, so
    // accept both.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Three-tier JWT recovery for the daemon (Q9 / B2):
 *
 *   1. If `credentials.json` holds a still-valid access token whose
 *      `serverUrl` matches the daemon's bound URL AND is loopback → use.
 *   2. Else attempt `/auth/refresh` with the cached refresh token.
 *   3. Else fall through to `/auth/local-bootstrap` — same-process call,
 *      the loopback gates trivially pass.
 *
 * On every successful step the new pair is persisted so subsequent boots
 * pick up from step 1. The pollution argument is the design's: always
 * going to local-bootstrap mints a fresh refresh-token row on every laptop
 * sleep/wake.
 *
 * @throws when none of the three tiers can produce a token (e.g. the
 *   server is down or refused all three paths).
 */
export async function obtainDaemonJWT(serverUrl: string): Promise<Tokens> {
  if (!isLoopbackUrl(serverUrl)) {
    throw new Error(`obtainDaemonJWT refuses non-loopback serverUrl ${serverUrl}`);
  }

  const cached = loadCredentials();
  if (cached && cached.serverUrl === serverUrl && isLoopbackUrl(cached.serverUrl)) {
    if (!isExpired(cached.accessToken)) return cached;
    const refreshed = await tryRefresh(cached);
    if (refreshed) {
      saveCredentials(refreshed);
      return refreshed;
    }
  }

  const minted = await tryLocalBootstrap(serverUrl);
  if (minted) {
    saveCredentials(minted);
    return minted;
  }

  throw new Error(
    "Daemon could not obtain a JWT pair. Cached credentials are invalid, " +
      "/auth/refresh failed, and /auth/local-bootstrap is unreachable. " +
      "Inspect 'first-tree-hub service logs' for details.",
  );
}

// Internal-only helpers exported for unit tests.
export const __testing = { decodeExp, isExpired, isLoopbackUrl };
