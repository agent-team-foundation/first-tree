/**
 * Whitelist for `next` redirect targets used by the SaaS auth flow. Both
 * the server (`/api/v1/auth/github/start` query) and the client
 * (`/auth/github/complete` fragment consumer) MUST validate against this
 * regex so a forged link can't bounce a victim off-origin while
 * persisting the attacker's tokens.
 *
 * Only forward-slash-prefixed paths whose body matches the URL-safe
 * character set are allowed. This blocks every documented bypass shape:
 *
 *   * `//evil.com`     — protocol-relative URL
 *   * `/\evil.com`     — backslash that browsers normalise to `/`
 *   * `https://evil`   — absolute URL
 *   * `javascript:…`   — pseudo-protocol
 *   * `/foo@evil.com`  — userinfo-style host smuggling once concatenated
 *
 * Callers that receive an invalid value should silently substitute `/`
 * — the user reaches the app shell either way; refusing the request
 * just adds friction without protection.
 */
export const SAFE_NEXT_PATH = /^\/(?![/\\])[A-Za-z0-9_\-./?=&%#]*$/;

export function sanitizeNextPath(raw: string | undefined | null): string {
  if (raw && SAFE_NEXT_PATH.test(raw)) return raw;
  return "/";
}
