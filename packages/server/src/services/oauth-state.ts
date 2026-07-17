import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

/**
 * State-token signing for the GitHub OAuth dance.
 *
 * Flow:
 *   1. `/auth/github/start` mints a `state` JWT *and* an HttpOnly cookie
 *      holding the same nonce. Both ride for ~10 minutes.
 *   2. GitHub redirects back to `/auth/github/callback?code=…&state=<jwt>`.
 *   3. Callback verifies the JWT (signature + expiry) AND that the cookie
 *      nonce matches `payload.nonce`. The double check defeats the
 *      classic login-CSRF where an attacker pre-signs a `start` with their
 *      own GitHub account and tricks a victim's browser into completing
 *      the callback under that identity.
 *
 * `next` rides inside the JWT so the caller's intended landing path can't
 * be tampered with mid-flight.
 */

const STATE_EXPIRY = "10m";
const NONCE_BYTES = 24;
export const OAUTH_STATE_COOKIE = "oauth_state_nonce";
export const OAUTH_STATE_COOKIE_MAX_AGE_S = 10 * 60;

type StatePayload = {
  /** Random nonce; must match the cookie's value. */
  nonce: string;
  /** Pre-validated relative path the SPA navigates to after consuming the fragment. */
  next: string;
  /**
   * First Tree org the resulting GitHub App installation should bind to. Set when
   * the flow was kicked off from an org's Settings → GitHub panel (codex
   * P1-3) — without it the callback would bind to the user's *primary*
   * org, which is wrong when an admin of org B installs the App. Absent on
   * the plain `/auth/github/start` sign-in flow.
   */
  targetOrganizationId?: string;
  /**
   * First Tree user who kicked off the App-install flow (the admin
   * authenticated by `GET /orgs/:orgId/github-app-installation/install-url`).
   * The callback rests the install *bind* on this identity — re-checked
   * live against `members` — instead of whoever the OAuth code resolves
   * to, because the browser's github.com session can legitimately differ
   * from the GitHub account linked to the kickoff user (second account,
   * deleted-and-recreated account, someone else's session in the same
   * browser). Absent on the plain `/auth/github/start` sign-in flow.
   */
  kickoffUserId?: string;
  intent?: "sign-in" | "link" | "unlink" | "install";
  userId?: string;
  provider?: "google" | "github";
  oidcNonce?: string;
  targetIdentityId?: string;
};

export type SignOAuthStateOptions = {
  /** See `StatePayload.targetOrganizationId`. */
  targetOrganizationId?: string;
  /** See `StatePayload.kickoffUserId`. */
  kickoffUserId?: string;
  intent?: "sign-in" | "link" | "unlink" | "install";
  userId?: string;
  provider?: "google" | "github";
  oidcNonce?: string;
  targetIdentityId?: string;
};

/**
 * Sign a fresh state token + return the matching cookie nonce. Caller is
 * responsible for setting the cookie (HttpOnly + Secure in prod).
 */
export async function signOAuthState(
  jwtSecret: string,
  next: string,
  opts: SignOAuthStateOptions = {},
): Promise<{ token: string; nonce: string }> {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const secret = new TextEncoder().encode(jwtSecret);
  const claims: StatePayload = { nonce, next };
  if (opts.targetOrganizationId) {
    claims.targetOrganizationId = opts.targetOrganizationId;
  }
  if (opts.kickoffUserId) {
    claims.kickoffUserId = opts.kickoffUserId;
  }
  if (opts.intent) claims.intent = opts.intent;
  if (opts.userId) claims.userId = opts.userId;
  if (opts.provider) claims.provider = opts.provider;
  if (opts.oidcNonce) claims.oidcNonce = opts.oidcNonce;
  if (opts.targetIdentityId) claims.targetIdentityId = opts.targetIdentityId;
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(STATE_EXPIRY)
    .sign(secret);
  return { token, nonce };
}

/**
 * Verify a state token. Returns the carried `next` on success. Throws
 * `Error` with the verification failure mode on rejection so the route
 * layer can map to 401.
 *
 * Cookie/nonce double-submit is mandatory — this is the CSRF defense.
 * `/dev-callback` does NOT call this function; it bypasses state entirely
 * (see `api/auth/github.ts`) because the dev shortcut also bypasses the
 * github.com round-trip that would have set a state cookie.
 */
export async function verifyOAuthState(
  jwtSecret: string,
  token: string,
  cookieNonce: string | null,
): Promise<{
  next: string;
  targetOrganizationId?: string;
  kickoffUserId?: string;
  intent?: "sign-in" | "link" | "unlink" | "install";
  userId?: string;
  provider?: "google" | "github";
  oidcNonce?: string;
  targetIdentityId?: string;
}> {
  const secret = new TextEncoder().encode(jwtSecret);
  let payload: StatePayload;
  try {
    const { payload: p } = await jwtVerify(token, secret);
    payload = p as unknown as StatePayload;
  } catch {
    throw new Error("Invalid or expired OAuth state");
  }

  if (typeof payload.nonce !== "string" || typeof payload.next !== "string") {
    throw new Error("OAuth state payload malformed");
  }
  if (payload.targetOrganizationId !== undefined && typeof payload.targetOrganizationId !== "string") {
    throw new Error("OAuth state payload malformed");
  }
  if (payload.kickoffUserId !== undefined && typeof payload.kickoffUserId !== "string") {
    throw new Error("OAuth state payload malformed");
  }
  if (payload.intent !== undefined && !["sign-in", "link", "unlink", "install"].includes(payload.intent)) {
    throw new Error("OAuth state payload malformed");
  }
  if (payload.provider !== undefined && payload.provider !== "google" && payload.provider !== "github") {
    throw new Error("OAuth state payload malformed");
  }
  for (const value of [payload.userId, payload.oidcNonce]) {
    if (value !== undefined && typeof value !== "string") throw new Error("OAuth state payload malformed");
  }
  if (payload.targetIdentityId !== undefined && typeof payload.targetIdentityId !== "string") {
    throw new Error("OAuth state payload malformed");
  }

  if (!cookieNonce || cookieNonce !== payload.nonce) {
    throw new Error("OAuth state nonce / cookie mismatch");
  }

  return {
    next: payload.next,
    ...(payload.targetOrganizationId ? { targetOrganizationId: payload.targetOrganizationId } : {}),
    ...(payload.kickoffUserId ? { kickoffUserId: payload.kickoffUserId } : {}),
    ...(payload.intent ? { intent: payload.intent } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.oidcNonce ? { oidcNonce: payload.oidcNonce } : {}),
    ...(payload.targetIdentityId ? { targetIdentityId: payload.targetIdentityId } : {}),
  };
}
