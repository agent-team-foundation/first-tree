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
};

/**
 * Sign a fresh state token + return the matching cookie nonce. Caller is
 * responsible for setting the cookie (HttpOnly + Secure in prod).
 */
export async function signOAuthState(jwtSecret: string, next: string): Promise<{ token: string; nonce: string }> {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const secret = new TextEncoder().encode(jwtSecret);
  const token = await new SignJWT({ nonce, next })
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
 * `cookieNonce` may be null when called from `/dev-callback` — we honor
 * the `skipCookieCheck` flag in that case but the route is itself gated
 * on dev mode.
 */
export async function verifyOAuthState(
  jwtSecret: string,
  token: string,
  cookieNonce: string | null,
  opts: { skipCookieCheck?: boolean } = {},
): Promise<{ next: string }> {
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

  if (!opts.skipCookieCheck) {
    if (!cookieNonce || cookieNonce !== payload.nonce) {
      throw new Error("OAuth state nonce / cookie mismatch");
    }
  }

  return { next: payload.next };
}
