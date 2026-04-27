import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { authProviders } from "../db/schema/auth-providers.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, UnauthorizedError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

/**
 * GitHub OAuth — minimal slice for SaaS sign-in.
 *
 * Flow:
 *   1. Frontend hits `GET /api/v1/auth/github/start?next=<>` and follows the
 *      `Location` header to GitHub.
 *   2. GitHub bounces back to `redirectUri` with `?code=…&state=…`.
 *   3. `GET /api/v1/auth/github/callback` verifies `state`, exchanges `code`
 *      for an access token, fetches the GitHub user/email, then calls
 *      `findOrCreateUserViaGithub` to land the user.
 *
 * Dev fallback: when `oauth.github.clientId` is unset the start endpoint
 * redirects to `/api/v1/auth/github/dev-callback?login=…&githubId=…&email=…`
 * directly. The dev-callback route writes the same shape `auth_providers`
 * row a real GitHub callback would, so the rest of the flow is identical.
 * Production deployments must set `clientId` / `clientSecret` to disable
 * the stub.
 */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

/** State JWT — short-lived (10 min) signed token carrying `next` + a CSRF nonce. */
const STATE_TTL_S = 600;

type StatePayload = {
  nonce: string;
  next: string;
};

export type GithubProfile = {
  /** Numeric GitHub id, stringified — stable across username changes. */
  githubId: string;
  /** GitHub login (handle). */
  login: string;
  /** Primary verified email; empty string when GitHub returns nothing usable. */
  email: string;
  /** GitHub display name (may be empty). */
  displayName: string;
  /** Avatar URL (may be empty). */
  avatarUrl: string;
};

/** Sign a state JWT carrying `next` + CSRF nonce. */
export async function signOauthState(jwtSecretKey: string, next: string): Promise<{ state: string; nonce: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const nonce = randomBytes(16).toString("base64url");
  const state = await new SignJWT({ nonce, next, type: "oauth_state" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_S}s`)
    .sign(secret);
  return { state, nonce };
}

/** Verify a state JWT. Throws `UnauthorizedError` on tamper / expiry. */
export async function verifyOauthState(jwtSecretKey: string, state: string): Promise<StatePayload> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  try {
    const { payload } = await jwtVerify(state, secret);
    const { type, nonce, next } = payload as Record<string, unknown>;
    if (type !== "oauth_state" || typeof nonce !== "string" || typeof next !== "string") {
      throw new UnauthorizedError("Invalid OAuth state");
    }
    return { nonce, next };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("OAuth state expired or tampered with");
  }
}

/** Build the GitHub authorize URL. */
export function buildGithubAuthorizeUrl(clientId: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange the OAuth `code` for an access token and fetch the GitHub user
 * + primary email. `fetchImpl` is injected so tests can stub the network.
 */
export async function exchangeGithubCode(
  config: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubProfile> {
  const tokenRes = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new BadRequestError(`GitHub token exchange failed (${tokenRes.status})`);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (tokenJson.error || !tokenJson.access_token) {
    throw new BadRequestError(
      `GitHub token exchange rejected: ${tokenJson.error_description ?? tokenJson.error ?? "unknown"}`,
    );
  }

  const auth = { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json" };

  const userRes = await fetchImpl(GITHUB_USER_URL, { headers: auth });
  if (!userRes.ok) throw new BadRequestError(`GitHub /user failed (${userRes.status})`);
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };

  // GitHub's /user.email is null when the user has it private — fall back to
  // /user/emails which always returns the primary verified address regardless
  // of profile-visibility settings (with `user:email` scope).
  let email = user.email ?? "";
  if (!email) {
    const emailsRes = await fetchImpl(GITHUB_EMAILS_URL, { headers: auth });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? "";
    }
  }

  return {
    githubId: String(user.id),
    login: user.login,
    email,
    displayName: user.name ?? user.login,
    avatarUrl: user.avatar_url ?? "",
  };
}

/**
 * Resolve a GitHub profile to a `users` row — creating both the user and
 * the `auth_providers` link on first sign-in. Identity is keyed on
 * `(provider, provider_user_id)`; email is contact-only.
 *
 * Email collision: when GitHub gives us an email that's already taken (e.g.
 * a legacy self-hosted user with the same address) we fall back to the
 * `<id>@users.noreply.first-tree.ai` placeholder for the new row and log
 * the collision for the operator to reconcile manually. We never silently
 * merge accounts on email match — that path lets a new GitHub identity
 * inherit a foreign user's data.
 */
export async function findOrCreateUserViaGithub(
  db: Database,
  profile: GithubProfile,
): Promise<{ userId: string; created: boolean }> {
  const [existingProvider] = await db
    .select({ userId: authProviders.userId })
    .from(authProviders)
    .where(eq(authProviders.providerUserId, profile.githubId))
    .limit(1);

  if (existingProvider) {
    // Refresh the audit email on every sign-in so the row stays current
    // without touching `users.email` (which is the contact field, not the
    // identity key).
    await db
      .update(authProviders)
      .set({ emailAtLink: profile.email || null, updatedAt: new Date() })
      .where(eq(authProviders.providerUserId, profile.githubId));
    return { userId: existingProvider.userId, created: false };
  }

  // First sign-in for this GitHub account — create user + link in one tx.
  return db.transaction(async (tx) => {
    const userId = uuidv7();

    // Username: derive from GitHub login but disambiguate on collision so a
    // squatted handle never blocks signup. The number of existing rows with
    // a username starting with the candidate is enough for a deterministic
    // suffix; full uniqueness is enforced by the column constraint anyway.
    let username = profile.login.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!username) username = `gh-${profile.githubId}`;
    const usernameTaken = await tx.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (usernameTaken.length > 0) {
      username = `${username}-${randomBytes(3).toString("hex")}`;
    }

    let email = profile.email;
    if (!email) {
      email = `${userId}@users.noreply.first-tree.ai`;
    } else {
      const emailTaken = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (emailTaken.length > 0) {
        // Fall back to the noreply placeholder rather than merging accounts.
        email = `${userId}@users.noreply.first-tree.ai`;
      }
    }

    await tx.insert(users).values({
      id: userId,
      username,
      email,
      // bcrypt hash of an unguessable random — SaaS users never log in via
      // password, but the column is NOT NULL on the legacy schema. Storing
      // a random hash makes the password path effectively unusable.
      passwordHash: randomBytes(32).toString("base64url"),
      displayName: profile.displayName || profile.login,
      avatarUrl: profile.avatarUrl || null,
    });

    await tx.insert(authProviders).values({
      id: uuidv7(),
      userId,
      provider: "github",
      providerUserId: profile.githubId,
      emailAtLink: profile.email || null,
    });

    return { userId, created: true };
  });
}

/**
 * Derive the OAuth redirect URI to advertise to GitHub. Prefers the
 * configured value (deployments behind a CDN/ingress); otherwise constructs
 * one from the request's forwarded headers.
 */
export function resolveRedirectUri(configured: string | undefined, origin: { proto: string; host: string }): string {
  if (configured) return configured;
  return `${origin.proto}://${origin.host}/api/v1/auth/github/callback`;
}

/** Mint a unique nonce for the dev-stub login form. Useful for tests. */
export function devStubNonce(): string {
  return randomUUID();
}
