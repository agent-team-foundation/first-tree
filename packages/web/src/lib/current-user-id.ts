/**
 * Synchronous access to the signed-in user's id, decoded from the stored
 * access token's JWT `sub` claim (a plain JWT, no decode lib needed).
 *
 * Lives outside React so non-React modules — the IndexedDB stores and the
 * logout purge — can resolve the current account without threading an id
 * through every call site. Mirrors the module-scope pattern `api/client.ts`
 * already uses for the selected organization id, and is the shared home of
 * the decode logic `auth-context.tsx` previously kept private.
 */

import { getStoredTokens } from "../api/client.js";

/**
 * The most recent non-null `sub` decoded in this page's lifetime.
 *
 * The 401 auto-logout path (`api/client.ts`) clears the stored tokens
 * BEFORE dispatching `auth:logout`, so by the time `logout()` runs, the
 * token — and with it the departing user's id — is already gone. This
 * cache preserves that identity so the purge still targets the right
 * account's local data.
 */
let lastKnownSub: string | null = null;

/**
 * Decode the current access token's `sub` claim, or `null` when signed out
 * (no token, malformed token, or unavailable storage). Synchronous — it
 * reads localStorage directly, so it is correct on first paint before `/me`
 * resolves. Every successful decode is also recorded for
 * `lastKnownUserId()`.
 */
export function currentUserIdFromToken(): string | null {
  try {
    const payload = getStoredTokens()?.accessToken?.split(".")[1];
    if (!payload) return null;
    const decoded: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof decoded === "object" && decoded !== null && "sub" in decoded) {
      const sub = decoded.sub;
      if (typeof sub === "string") {
        lastKnownSub = sub;
        return sub;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The last user id `currentUserIdFromToken()` successfully decoded in this
 * page's lifetime, or `null` when no token has been seen. Used as the
 * logout purge's fallback identity for the 401 auto-logout sequence, where
 * the tokens are cleared before the logout handler runs.
 */
export function lastKnownUserId(): string | null {
  return lastKnownSub;
}
