import { importPKCS8, SignJWT } from "jose";

/**
 * GitHub App service helpers — the three primitives that ride on top of an
 * App's private key:
 *
 *   1. `createAppJwt`        — sign the short-lived (≤10min) App JWT that
 *                              identifies Hub-as-an-App to GitHub.
 *   2. `mintInstallationToken` — exchange the App JWT for a per-installation
 *                              server-to-server token (~1h TTL). Used when
 *                              Hub itself needs to act as the App on a
 *                              tenant's repos (Phase 4 identity convergence;
 *                              not yet wired into request paths).
 *   3. `refreshAppUserToken` — slide an expiring user-to-server access token
 *                              by trading in its refresh token. Powers the
 *                              ~8h-TTL user session that replaces the
 *                              never-expires legacy OAuth token.
 *
 * Design context: `docs/github-app-design-zh.md` §3 ("one installation, three
 * capabilities") + §5.4 ("services/github-app.ts").
 *
 * Stateless by construction: this module imports no DB / config singletons.
 * Callers thread the App credentials in explicitly — the wiring layer that
 * pulls them from env arrives in PR-C.
 */

const APP_JWT_ALG = "RS256";
/**
 * GitHub rejects App JWTs past 10 minutes; we ride 9 minutes so callers
 * don't trip the upper bound from clock skew. Generous-but-safe — the JWT
 * is cheap to mint (one RS256 signature) so caching is unnecessary.
 */
const APP_JWT_EXPIRY = "9m";
/**
 * GitHub allows a small backdated `iat` to absorb clock skew on the
 * caller's side; the docs recommend 60 seconds. We mirror that.
 */
const APP_JWT_IAT_SKEW_SECONDS = 60;

const APP_INSTALLATION_TOKEN_URL = (id: number) => `https://api.github.com/app/installations/${id}/access_tokens`;
const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Errors from any GitHub API call this module makes. Carries the HTTP
 * status so route layers can disambiguate auth/permission failures (401 /
 * 403 / 404) from transient upstream errors (5xx / network).
 *
 * Distinct from `github-oauth.ts`'s `GithubApiError` because the App API
 * surface is a different concern (App-private-key vs. OAuth client
 * credentials) and we want logs / metrics to tell them apart at a glance.
 */
export class GithubAppApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubAppApiError";
  }
}

export type GithubAppCredentials = {
  /** App ID from the GitHub App's settings page (numeric, but GitHub returns it as a string in some envs). */
  appId: string;
  /** RSA private key in PKCS#8 PEM form (`-----BEGIN PRIVATE KEY-----…`). */
  privateKeyPem: string;
};

/**
 * Mint an App JWT. RS256-signed; identifies Hub-as-this-App to GitHub for
 * the next ~9 minutes. Use this directly for `/app/...` endpoints and as
 * the input to `mintInstallationToken` for `/installation/...` endpoints.
 *
 * The PEM is imported on every call. The cost is negligible (microseconds)
 * and avoids a global mutable cache — keeps this module trivially safe to
 * call from parallel request handlers without locking. If profiling ever
 * shows this is a hotspot, add a per-key memoization at the caller side.
 */
export async function createAppJwt(creds: GithubAppCredentials): Promise<string> {
  const key = await importPKCS8(creds.privateKeyPem, APP_JWT_ALG);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: APP_JWT_ALG })
    .setIssuer(creds.appId)
    .setIssuedAt(now - APP_JWT_IAT_SKEW_SECONDS)
    .setExpirationTime(APP_JWT_EXPIRY)
    .sign(key);
}

export type InstallationToken = {
  /** Opaque server-to-server token. Bearer-style. */
  token: string;
  /** ISO-8601, ~1h after issue. Re-mint past this. */
  expiresAt: string;
  /** Permissions GitHub actually granted on this installation (may be a subset of what the App declares). */
  permissions: Record<string, "read" | "write" | "admin">;
  /** "all" (all repos in the account) | "selected" (subset; webhook payload carries the list). */
  repositorySelection: "all" | "selected";
};

/**
 * Mint a per-installation token (server-to-server). The token is cheap
 * (one signature + one HTTP round-trip) and the upstream TTL is ~1h, so
 * the recommended caller pattern is "mint per request" rather than caching
 * — caching forces the caller to also track expiry, suspended state, and
 * GitHub-side permission churn, which the design explicitly punts to Phase
 * 4. We give callers a typed result and let them cache if profiling shows
 * the round-trip is hot.
 *
 * Throws `GithubAppApiError` on non-2xx. 401 means the App JWT is bad or
 * the App's key has been rotated upstream; 404 means the installation
 * was uninstalled. Callers SHOULD persist the suspension state when 403
 * comes back with `suspended` (the design tracks this as `suspended_at`
 * on `github_app_installations`).
 */
export async function mintInstallationToken(
  appJwt: string,
  installationId: number,
  opts: { fetcher?: typeof fetch } = {},
): Promise<InstallationToken> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(APP_INSTALLATION_TOKEN_URL(installationId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new GithubAppApiError(res.status, `GitHub App installation-token request failed (${res.status})`);
  }
  const body = (await res.json()) as {
    token: string;
    expires_at: string;
    permissions?: Record<string, "read" | "write" | "admin">;
    repository_selection?: "all" | "selected";
  };
  return {
    token: body.token,
    expiresAt: body.expires_at,
    permissions: body.permissions ?? {},
    // GitHub omits `repository_selection` for personal installs where the
    // distinction is degenerate; default to "all" so downstream code has
    // one fewer optional to thread through.
    repositorySelection: body.repository_selection ?? "all",
  };
}

export type RefreshedUserToken = {
  accessToken: string;
  /** ISO-8601. Typically ~8h after issue. */
  accessTokenExpiresAt: string;
  /**
   * GitHub re-issues a fresh refresh token on every refresh (rotation).
   * Callers MUST persist this — using the old refresh token after a
   * successful rotation will fail with `bad_refresh_token`.
   */
  refreshToken: string;
  /** ISO-8601. Typically ~6mo after issue. */
  refreshTokenExpiresAt: string;
  /** Granted scopes, comma-joined. Forwarded verbatim from GitHub. */
  scope: string;
};

/**
 * Trade an expiring user-to-server access token for a fresh pair using
 * its refresh token. Thrown on:
 *   - Network / 5xx           — `GithubAppApiError(status, …)`
 *   - 4xx with no JSON body   — `GithubAppApiError(status, …)`
 *   - 200 with `error` field  — `GithubAppApiError(401, …)` (GitHub returns
 *     200 OK for an unusable refresh token but signals the error in the
 *     body; we normalize to 401 so route layers can map to "re-login")
 *
 * Designed to be called from the OAuth callback / token-refresh path
 * landing in PR-C. The caller decrypts the stored refresh token, hands
 * the plaintext in here, encrypts the returned pair, and writes both
 * tokens + expiries back to `auth_identities.metadata`.
 */
export async function refreshAppUserToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  opts: { fetcher?: typeof fetch; now?: () => Date } = {},
): Promise<RefreshedUserToken> {
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? (() => new Date());
  const res = await fetcher(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new GithubAppApiError(res.status, `GitHub user-token refresh failed (${res.status})`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (body.error || !body.access_token || !body.refresh_token) {
    // GitHub returns 200 OK with `error` / `error_description` when the
    // refresh token is malformed, expired, or already-rotated. Normalize
    // to 401 because the caller's only sane response is "re-login".
    const description = body.error_description ?? body.error ?? "missing access_token / refresh_token";
    throw new GithubAppApiError(401, `GitHub user-token refresh rejected: ${description}`);
  }
  if (typeof body.expires_in !== "number" || typeof body.refresh_token_expires_in !== "number") {
    // GitHub Apps always include both `*_expires_in` fields in the refresh
    // response. If one is missing the deployment is misconfigured (e.g.
    // App still has "Expire user authorization tokens" disabled in the
    // settings page) — fail loudly rather than persist a row that lies
    // about when the token expires.
    throw new GithubAppApiError(
      500,
      "GitHub user-token refresh response missing expires_in fields — App likely has user-token expiration disabled",
    );
  }
  const issuedAt = now();
  const accessExpiresAt = new Date(issuedAt.getTime() + body.expires_in * 1000);
  const refreshExpiresAt = new Date(issuedAt.getTime() + body.refresh_token_expires_in * 1000);
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: accessExpiresAt.toISOString(),
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    scope: body.scope ?? "",
  };
}
