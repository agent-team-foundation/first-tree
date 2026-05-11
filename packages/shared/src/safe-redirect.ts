/**
 * Single source of truth for "is this string safe to redirect to after a
 * successful OAuth callback".
 *
 * Both the server (`/auth/github/start` validates `?next=` before signing
 * the state JWT) and the web client (the fragment-consumer page validates
 * before navigating) must agree on the regex — drift here is what enables
 * open-redirect bugs. The server is authoritative; the client check is a
 * defense-in-depth.
 *
 * Allowed: a path that begins with exactly one `/` and is not the start of
 * an authority component (`//`, `/\`). Permits typical SPA paths with
 * query strings and fragments. Anything else (absolute URLs, scheme-less
 * authority components, `javascript:`) falls through to the safe default.
 */
const SAFE_NEXT_PATH = /^\/(?![/\\])[A-Za-z0-9_\-./?=&%#]*$/;

/** Default landing path used when `next` is absent or rejected. */
export const DEFAULT_SAFE_REDIRECT = "/";

/**
 * Return `next` if it is a syntactically safe relative path, otherwise the
 * default landing path. The check is deliberately conservative — the
 * intent is to reject anything that could be parsed as an absolute URL by
 * a browser navigation. Length is capped at 256 chars to defang
 * pathological inputs.
 */
export function safeRedirectPath(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return DEFAULT_SAFE_REDIRECT;
  if (next.length > 256) return DEFAULT_SAFE_REDIRECT;
  if (!SAFE_NEXT_PATH.test(next)) return DEFAULT_SAFE_REDIRECT;
  return next;
}

export const __test__ = { SAFE_NEXT_PATH };
