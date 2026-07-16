import { importPKCS8, SignJWT } from "jose";
import type { GithubProfile } from "./auth-identity.js";
import { GITHUB_API_BASE } from "./github-api-base.js";
import type { GithubCreatedRepo, GithubRepo } from "./github-oauth.js";

/**
 * GitHub App service helpers. Two surfaces that ride on top of an App's
 * private key + OAuth client credentials:
 *
 *   App-private-key (server-to-server):
 *   - `createAppJwt`           — short-lived (≤10min) JWT identifying
 *                                 First-Tree-as-this-App to GitHub.
 *   - `mintInstallationToken`  — exchange the App JWT for a per-installation
 *                                 token (~1h TTL). Used when First Tree acts as the
 *                                 App on a tenant's repos (Phase 4 identity
 *                                 convergence — not yet wired into request
 *                                 paths).
 *
 *   App-OAuth (user-to-server, replaces the legacy OAuth App flow):
 *   - `buildAppAuthorizeUrl`         — the start URL for the combined OAuth
 *                                       + install flow (design doc D1).
 *   - `exchangeCodeForAppUserProfile` — callback-side token exchange that
 *                                       returns the user's profile, the
 *                                       access + refresh tokens, and their
 *                                       absolute expiries.
 *   - `refreshAppUserToken`           — slide an expiring access token by
 *                                       trading in its refresh token.
 *
 * Design context: the GitHub App design in the First Tree context tree —
 * `system/cloud/github/github-app.md` ("one installation, three capabilities").
 *
 * Stateless by construction: no DB / config singletons. Callers thread
 * credentials in explicitly so the module is trivially safe under
 * concurrent request handlers.
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

const APP_INSTALLATION_TOKEN_URL = (id: number) => `${GITHUB_API_BASE}/app/installations/${id}/access_tokens`;
const APP_INSTALLATION_URL = (id: number) => `${GITHUB_API_BASE}/app/installations/${id}`;
const INSTALLATION_REPOS_URL = `${GITHUB_API_BASE}/installation/repositories`;
const ORGANIZATION_REPOS_URL = (org: string) => `${GITHUB_API_BASE}/orgs/${encodeURIComponent(org)}/repos`;
const REPOSITORY_URL = (owner: string, repo: string) =>
  `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const REPOSITORY_CONTENTS_URL = (owner: string, repo: string, path: string) =>
  `${REPOSITORY_URL(owner, repo)}/contents/${encodePath(path)}`;
const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const USER_API_URL = `${GITHUB_API_BASE}/user`;
const USER_EMAILS_API_URL = `${GITHUB_API_BASE}/user/emails`;
const USER_MEMBERSHIPS_API_URL = (org: string) => `${GITHUB_API_BASE}/user/memberships/orgs/${encodeURIComponent(org)}`;

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
 * Mint an App JWT. RS256-signed; identifies First-Tree-as-this-App to GitHub for
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

/**
 * Installation metadata as returned by `GET /app/installations/:id`.
 * Mirrors the `installation` block on webhook payloads (intentional —
 * the same shape lands in `github_app_installations` whether it was
 * pulled via this endpoint or pushed by webhook).
 */
export type AppInstallation = {
  id: number;
  accountType: "User" | "Organization";
  accountLogin: string;
  accountGithubId: number;
  permissions: Record<string, "read" | "write" | "admin">;
  events: string[];
  /** ISO-8601 if suspended upstream; null when active. */
  suspendedAt: string | null;
};

/**
 * Fetch the installation metadata. Used by the OAuth callback path to
 * resolve the bare `installation_id` query param into a full row before
 * UPSERTing into `github_app_installations` — so the callback doesn't
 * depend on the `installation: created` webhook arriving first
 * (delivery order between callback and webhook is not guaranteed).
 *
 * The webhook handler skips this call entirely because the payload it
 * receives already carries the same shape.
 */
export async function fetchInstallation(
  appJwt: string,
  installationId: number,
  opts: { fetcher?: typeof fetch } = {},
): Promise<AppInstallation> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(APP_INSTALLATION_URL(installationId), {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new GithubAppApiError(res.status, `GitHub App installation fetch failed (${res.status})`);
  }
  const body = (await res.json()) as {
    id: number;
    account: { id: number; login: string; type: "User" | "Organization" };
    permissions?: Record<string, "read" | "write" | "admin">;
    events?: string[];
    suspended_at?: string | null;
  };
  return {
    id: body.id,
    accountType: body.account.type,
    accountLogin: body.account.login,
    accountGithubId: body.account.id,
    permissions: body.permissions ?? {},
    events: body.events ?? [],
    suspendedAt: body.suspended_at ?? null,
  };
}

/**
 * Verify the authenticated GitHub user can actually administer this
 * installation. The OAuth callback and the manual `claim` endpoint both
 * use this: `installation_id` arrives over insecure channels (browser
 * address bar, API body) and isn't a secret, so we MUST prove the caller
 * owns / admins the GitHub account the install lives under before
 * binding it to a First Tree org.
 *
 * Rules — strict, per GitHub's account model:
 *
 *   - `accountType === "User"`: only the account owner counts. Compare
 *     `installation.accountGithubId` to the caller's own GitHub ID. The
 *     stable numeric ID survives login renames.
 *
 *   - `accountType === "Organization"`: require `role === "admin"` and
 *     `state === "active"` on the org via `GET /user/memberships/orgs/{login}`.
 *     A pending invite (state=pending) does NOT grant admin rights even
 *     when role=admin. Non-admins can't lie because the token only sees
 *     the caller's own membership. Requires the App's
 *     `organization:members:read` permission.
 *
 * Why NOT `GET /user/installations`: it lists installs the user has
 * `:read` / `:write` / `:admin` access to — plain org membership is
 * enough to appear, no admin role required. Membership alone is what
 * made the original primitive forgeable.
 *
 * Throws `GithubAppApiError` on transient upstream failures (callers
 * should fail closed and refuse the bind). Returns `false` cleanly for
 * the "not allowed" path (404 on org membership, ID mismatch on User
 * installs).
 */
export async function verifyUserCanAdministerInstallation(
  userAccessToken: string,
  userGithubId: number,
  installation: { accountType: "User" | "Organization"; accountLogin: string; accountGithubId: number },
  opts: { fetcher?: typeof fetch } = {},
): Promise<boolean> {
  if (installation.accountType === "User") {
    return installation.accountGithubId === userGithubId;
  }
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(USER_MEMBERSHIPS_API_URL(installation.accountLogin), {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  // 404 = not a member of this org. Clean negative answer; not an error.
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new GithubAppApiError(
      res.status,
      `GitHub /user/memberships/orgs/${installation.accountLogin} failed (${res.status})`,
    );
  }
  const body = (await res.json()) as { state?: string; role?: string };
  return body.state === "active" && body.role === "admin";
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
  opts: {
    fetcher?: typeof fetch;
    repositories?: readonly string[];
    permissions?: Record<string, "read" | "write">;
  } = {},
): Promise<InstallationToken> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(APP_INSTALLATION_TOKEN_URL(installationId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body:
      opts.repositories || opts.permissions
        ? JSON.stringify({ repositories: opts.repositories, permissions: opts.permissions })
        : undefined,
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

export type GithubPullRequestForReview = {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headSha: string;
  htmlUrl: string;
};

export type GithubPullRequestReview = {
  id: number;
  htmlUrl: string;
  actor: string;
  commitId: string | null;
  body: string;
  state: string | null;
};

function pullRequestUrl(owner: string, repo: string, prNumber: number): string {
  return `${REPOSITORY_URL(owner, repo)}/pulls/${prNumber}`;
}

function installationHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function getPullRequestForReview(
  installationToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  opts: { fetcher?: typeof fetch } = {},
): Promise<GithubPullRequestForReview> {
  const res = await (opts.fetcher ?? fetch)(pullRequestUrl(owner, repo, prNumber), {
    headers: installationHeaders(installationToken),
  });
  if (!res.ok) {
    throw new GithubAppApiError(res.status, `GitHub pull request fetch failed (${res.status})`);
  }
  const body = (await res.json()) as {
    number: number;
    state: "open" | "closed";
    draft?: boolean;
    merged?: boolean;
    merged_at?: string | null;
    head: { sha: string };
    html_url: string;
  };
  return {
    number: body.number,
    state: body.state,
    draft: body.draft === true,
    merged: body.merged === true || body.merged_at != null,
    headSha: body.head.sha,
    htmlUrl: body.html_url,
  };
}

export async function createPullRequestReview(
  installationToken: string,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    commitId: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
  },
  opts: { fetcher?: typeof fetch } = {},
): Promise<GithubPullRequestReview> {
  const res = await (opts.fetcher ?? fetch)(`${pullRequestUrl(input.owner, input.repo, input.prNumber)}/reviews`, {
    method: "POST",
    headers: { ...installationHeaders(installationToken), "Content-Type": "application/json" },
    body: JSON.stringify({ commit_id: input.commitId, event: input.event, body: input.body }),
  });
  if (!res.ok) {
    throw new GithubAppApiError(res.status, `GitHub pull request review creation failed (${res.status})`);
  }
  return parsePullRequestReview(await res.json());
}

export async function listPullRequestReviewsForRun(
  installationToken: string,
  input: { owner: string; repo: string; prNumber: number; marker: string; appSlug: string },
  opts: { fetcher?: typeof fetch } = {},
): Promise<GithubPullRequestReview[]> {
  const matches: GithubPullRequestReview[] = [];
  for (let page = 1; ; page += 1) {
    const pageParam = page === 1 ? "" : `&page=${page}`;
    const res = await (opts.fetcher ?? fetch)(
      `${pullRequestUrl(input.owner, input.repo, input.prNumber)}/reviews?per_page=100${pageParam}`,
      { headers: installationHeaders(installationToken) },
    );
    if (!res.ok) {
      throw new GithubAppApiError(res.status, `GitHub pull request review list failed (${res.status})`);
    }
    const reviews = (await res.json()) as unknown[];
    matches.push(
      ...reviews
        .map(parsePullRequestReview)
        .filter((review) => review.actor === `${input.appSlug}[bot]` && review.body.includes(input.marker)),
    );
    if (reviews.length < 100) return matches;
  }
}

function parsePullRequestReview(value: unknown): GithubPullRequestReview {
  const body = value as {
    id: number;
    html_url: string;
    user?: { login?: string };
    commit_id?: string | null;
    body?: string | null;
    state?: string | null;
  };
  if (!Number.isInteger(body.id) || !body.html_url || !body.user?.login) {
    throw new GithubAppApiError(502, "GitHub pull request review response was malformed");
  }
  return {
    id: body.id,
    htmlUrl: body.html_url,
    actor: body.user.login,
    commitId: body.commit_id ?? null,
    body: body.body ?? "",
    state: body.state ?? null,
  };
}

/**
 * List the repositories an installation can access, via
 * `GET /installation/repositories` with an installation token (mint one
 * with `mintInstallationToken` first).
 *
 * This is the honest "what can the agent actually work on" set: it's the
 * subset of repos the App was granted on this account, so it's naturally
 * scoped to the bound team org and excludes the caller's unrelated personal
 * repos (which the team-by-default product deliberately does not surface in
 * onboarding). Contrast `listUserRepos`, which proxies the *user's* OAuth
 * `/user/repos` — personal + every org the user belongs to, with no notion
 * of whether the agent can reach any of them.
 *
 * Returns the same `GithubRepo` shape as `listUserRepos` so the repo picker
 * is source-agnostic. Sorted by most-recently-pushed (the endpoint has no
 * `sort` param, so we order client-side to match the OAuth picker's feel).
 * Walks paginated responses up to the cap.
 *
 * Throws `GithubAppApiError` on non-2xx (401 = bad/expired installation
 * token, 403 = suspended, 5xx = transient upstream).
 */
export async function listInstallationRepos(
  installationToken: string,
  opts: { fetcher?: typeof fetch; perPage?: number; maxPages?: number } = {},
): Promise<GithubRepo[]> {
  const fetcher = opts.fetcher ?? fetch;
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 5;
  const out: GithubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetcher(`${INSTALLATION_REPOS_URL}?per_page=${perPage}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new GithubAppApiError(res.status, `GitHub installation repo list failed (${res.status})`);
    }
    // Unlike `/user/repos` (a bare array), this endpoint wraps the page in
    // `{ total_count, repositories: [...] }`.
    const body = (await res.json()) as {
      repositories?: Array<{
        full_name: string;
        clone_url: string;
        html_url: string;
        private: boolean;
        default_branch?: string | null;
        pushed_at?: string | null;
      }>;
    };
    const rows = body.repositories ?? [];
    for (const r of rows) {
      out.push({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        htmlUrl: r.html_url,
        private: r.private,
        defaultBranch: r.default_branch ?? null,
        pushedAt: r.pushed_at ?? null,
      });
    }
    if (rows.length < perPage) break;
  }
  // Most-recently-pushed first; repos without a pushedAt sort last.
  out.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  return out;
}

/**
 * Create a repository under an organization account using a GitHub App
 * installation token. GitHub supports this only for organization installs
 * whose token has `administration: write`; callers should enforce that before
 * invoking the upstream side effect so permission failures are stable and
 * explainable.
 */
export async function createOrganizationRepo(
  installationToken: string,
  input: { org: string; name: string; description?: string; private: boolean },
  opts: { fetcher?: typeof fetch } = {},
): Promise<GithubCreatedRepo> {
  const fetcher = opts.fetcher ?? fetch;
  const payload: Record<string, unknown> = {
    name: input.name,
    private: input.private,
    auto_init: false,
  };
  if (input.description) payload.description = input.description;

  const res = await fetcher(ORGANIZATION_REPOS_URL(input.org), {
    method: "POST",
    headers: githubJsonHeaders(installationToken),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw await githubAppApiError(res, "GitHub organization repo create failed");
  }
  return parseGithubRepo(await res.json(), "GitHub organization repo create returned an invalid response");
}

/**
 * Read a repository with an installation token. The Context Tree initializer
 * uses this as the same authority check the snapshot path relies on: if the
 * bound installation cannot read the repo, First Tree must not persist it as
 * this team's tree binding.
 */
export async function getRepository(
  installationToken: string,
  owner: string,
  repo: string,
  opts: { fetcher?: typeof fetch } = {},
): Promise<GithubCreatedRepo> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(REPOSITORY_URL(owner, repo), {
    headers: githubJsonHeaders(installationToken),
  });
  if (!res.ok) {
    throw await githubAppApiError(res, "GitHub repository fetch failed");
  }
  return parseGithubRepo(await res.json(), "GitHub repository fetch returned an invalid response");
}

export async function getRepoFileWithToken(
  installationToken: string,
  input: { owner: string; repo: string; path: string; branch: string },
  opts: { fetcher?: typeof fetch } = {},
): Promise<void> {
  const fetcher = opts.fetcher ?? fetch;
  const url = new URL(REPOSITORY_CONTENTS_URL(input.owner, input.repo, input.path));
  url.searchParams.set("ref", input.branch);
  const res = await fetcher(url.toString(), {
    headers: githubJsonHeaders(installationToken),
  });
  if (!res.ok) {
    throw await githubAppApiError(res, "GitHub file fetch failed");
  }
}

export async function createRepoFileWithToken(
  installationToken: string,
  input: { owner: string; repo: string; path: string; branch: string; message: string; contentBase64: string },
  opts: { fetcher?: typeof fetch } = {},
): Promise<void> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(REPOSITORY_CONTENTS_URL(input.owner, input.repo, input.path), {
    method: "PUT",
    headers: githubJsonHeaders(installationToken),
    body: JSON.stringify({
      message: input.message,
      content: input.contentBase64,
      branch: input.branch,
    }),
  });
  if (!res.ok) {
    throw await githubAppApiError(res, "GitHub file create failed");
  }
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

function githubJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubAppApiError(res: Response, fallback: string): Promise<GithubAppApiError> {
  const upstreamMessage = await readGithubErrorMessage(res);
  return new GithubAppApiError(
    res.status,
    `${fallback} (${res.status})${upstreamMessage ? `: ${upstreamMessage}` : ""}`,
  );
}

async function readGithubErrorMessage(res: Response): Promise<string | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await res.json().catch(() => null);
    if (isRecord(body)) {
      const message = readString(body, "message");
      if (message) return message;
    }
    return null;
  }
  const text = await res.text().catch(() => "");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

function parseGithubRepo(body: unknown, invalidMessage: string): GithubCreatedRepo {
  if (!isRecord(body)) {
    throw new GithubAppApiError(502, invalidMessage);
  }
  const owner = isRecord(body.owner) ? readString(body.owner, "login") : null;
  const name = readString(body, "name");
  const fullName = readString(body, "full_name");
  const cloneUrl = readString(body, "clone_url");
  const htmlUrl = readString(body, "html_url");
  const isPrivate = readBoolean(body, "private");
  if (!owner || !name || !fullName || !cloneUrl || !htmlUrl || isPrivate === null) {
    throw new GithubAppApiError(502, invalidMessage);
  }
  return {
    name,
    fullName,
    ownerLogin: owner,
    cloneUrl,
    htmlUrl,
    private: isPrivate,
    defaultBranch: readString(body, "default_branch"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

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

/**
 * Build the App's combined OAuth + install authorization URL. Per design
 * doc D1 ("login → install in one redirect"), this is the SAME endpoint
 * GitHub uses for both flows when the App has "Request user authorization
 * (OAuth) during installation" enabled — first install lands the user on
 * the install dialog → consents → GitHub bounces back to `redirect_uri`
 * with both `code` (OAuth) and `installation_id` (the new install).
 * Returning users skip the install dialog and just receive `code`.
 *
 * `state` is the signed JWT minted by `oauth-state.ts` — same CSRF defense
 * as the legacy OAuth flow.
 *
 * Permissions are NOT in the URL — the App declares them once in its
 * GitHub-side settings (design doc D0b) and the install dialog renders
 * them automatically. Asking again in the URL would let an attacker
 * craft a downgrade prompt.
 */
export function buildAppAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

const APP_INSTALL_URL = (slug: string) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/**
 * Build the App's `installations/new` URL — the one that actually surfaces
 * GitHub's install dialog (repo picker + permission review). Distinct from
 * `buildAppAuthorizeUrl`:
 *
 *   - `authorize` (login URL) → for a user who already has the App
 *     installed, returns `code`. For one who DOESN'T, it only triggers
 *     OAuth consent — no install dialog, no `installation_id` ever comes
 *     back. So "Install on GitHub" CTAs that point at `authorize` silently
 *     never produce an install (codex P1-1).
 *   - `installations/new` → always shows the install picker. After the
 *     user confirms, GitHub redirects to the App's configured callback /
 *     setup URL with `installation_id` and (because the App has "Request
 *     user authorization (OAuth) during installation" enabled, D1) also
 *     `code` + the `state` we threaded through here.
 *
 * `state` is the same signed JWT minted by `oauth-state.ts` — GitHub
 * round-trips it on the post-install redirect, so the callback can verify
 * CSRF + recover `next` + (codex P1-3) the target org to bind to.
 */
export function buildAppInstallUrl(opts: { appSlug: string; state: string }): string {
  const url = new URL(APP_INSTALL_URL(opts.appSlug));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export type ExchangeAppCodeResult = {
  profile: GithubProfile;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  scope: string;
  /**
   * Forwarded from the callback `installation_id` query param, NOT from
   * the token response. GitHub puts it in the redirect URL when the user
   * just installed the App; returning users (who already had the App
   * installed) won't carry it. Caller is responsible for plumbing this
   * through alongside the exchanged code.
   */
  installationId: number | null;
};

/**
 * App-flavoured `exchangeCodeForProfile`: trade the callback `code` for
 * the user's profile + a full token pair (access + refresh + expiries).
 *
 * Why this exists alongside `github-oauth.ts.exchangeCodeForProfile`:
 *   - Same endpoint (`/login/oauth/access_token`) but with App
 *     client_id/secret instead of OAuth App credentials.
 *   - Response carries `refresh_token` + `expires_in` +
 *     `refresh_token_expires_in` (8h / 6mo TTLs) that the OAuth-only
 *     version doesn't return.
 *   - The token-rotation semantics (`refresh_token` will be reissued on
 *     every refresh) mean the caller MUST persist all four fields, not
 *     just `accessToken`.
 *
 * The OAuth-only helper stays put for the brief window between this
 * commit and the OAuth-flow rewrite; D3 cutover deletes it outright.
 */
export async function exchangeCodeForAppUserProfile(
  opts: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    installationId: number | null;
  },
  callOpts: { fetcher?: typeof fetch; now?: () => Date } = {},
): Promise<ExchangeAppCodeResult> {
  const fetcher = callOpts.fetcher ?? fetch;
  const now = callOpts.now ?? (() => new Date());

  const tokenRes = await fetcher(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new GithubAppApiError(tokenRes.status, `GitHub App user-token exchange failed (${tokenRes.status})`);
  }
  const body = (await tokenRes.json()) as {
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
    // Same 200-with-error convention as `refreshAppUserToken` — normalize
    // to 401 so route layer maps to "re-login / re-consent".
    const description = body.error_description ?? body.error ?? "missing access_token / refresh_token";
    throw new GithubAppApiError(401, `GitHub App user-token exchange rejected: ${description}`);
  }
  if (typeof body.expires_in !== "number" || typeof body.refresh_token_expires_in !== "number") {
    // App MUST have "Expire user authorization tokens" enabled in its
    // settings page — otherwise we'd persist a row that lies about its
    // TTL. Fail loud rather than silently downgrade to "never expires".
    throw new GithubAppApiError(
      500,
      "GitHub App user-token exchange missing expires_in — App must have user-token expiration enabled",
    );
  }
  const issuedAt = now();
  const accessExpiresAt = new Date(issuedAt.getTime() + body.expires_in * 1000);
  const refreshExpiresAt = new Date(issuedAt.getTime() + body.refresh_token_expires_in * 1000);

  // Fetch profile via `/user`; fall back to `/user/emails` when GitHub
  // hides the primary email on the public profile (private-email setting).
  // Mirrors `github-oauth.ts.exchangeCodeForProfile`; the legacy helper
  // stays put until D3 cutover deletes it.
  const userRes = await fetcher(USER_API_URL, {
    headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) {
    throw new GithubAppApiError(userRes.status, `GitHub /user fetch failed (${userRes.status})`);
  }
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };

  let email = user.email ?? null;
  if (!email) {
    const emailsRes = await fetcher(USER_EMAILS_API_URL, {
      headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/vnd.github+json" },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      email = primary?.email ?? null;
    }
  }

  return {
    profile: {
      githubId: String(user.id),
      login: user.login,
      email,
      displayName: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
    },
    accessToken: body.access_token,
    accessTokenExpiresAt: accessExpiresAt.toISOString(),
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    scope: body.scope ?? "",
    installationId: opts.installationId,
  };
}
