import { DEFAULT_SAFE_REDIRECT, safeRedirectPath } from "@first-tree/shared";

/**
 * Read the `{from: Location}` state set by `RequireAuth` when it
 * redirects an unauthenticated deep-link visitor to /login. router-7
 * types `location.state` as `unknown`, so we narrow without `as` casts.
 *
 * Returns the assembled `pathname + search + hash` only if it survives
 * the same `safeRedirectPath` validator the GitHub OAuth flow uses for
 * `?next=` (256-char cap, scheme-relative URL rejection, etc.) and is
 * not /login itself. Sharing the validator across both auth paths keeps
 * post-auth landing rules in lock-step — drift between password and
 * OAuth post-login redirects is what enables open-redirect bugs.
 *
 * Returns `null` (not the substituted "/") for unsafe / missing input,
 * so the caller's `?? "/"` fallback fires uniformly for every reject
 * case.
 */
export function readFromPath(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  if (!("from" in state)) return null;
  const from = state.from;
  if (typeof from !== "object" || from === null) return null;
  if (!("pathname" in from) || typeof from.pathname !== "string") return null;
  // Loop break: never bounce back to /login (safeRedirectPath does not
  // know /login is the loop point — it only checks shape).
  if (from.pathname === "/login") return null;
  const search = "search" in from && typeof from.search === "string" ? from.search : "";
  const hash = "hash" in from && typeof from.hash === "string" ? from.hash : "";
  const assembled = `${from.pathname}${search}${hash}`;
  const safe = safeRedirectPath(assembled);
  // safeRedirectPath substitutes "/" for any rejected input. Convert that
  // sentinel back to null when the original was anything other than "/",
  // so callers can `?? "/"` uniformly for both "no state" and "rejected".
  return safe === DEFAULT_SAFE_REDIRECT && assembled !== DEFAULT_SAFE_REDIRECT ? null : safe;
}
