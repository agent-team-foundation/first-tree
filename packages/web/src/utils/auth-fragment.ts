/**
 * Parse the URL fragment delivered by the server's OAuth callback redirect.
 * Server packs `?access=…&refresh=…&next=…` into the fragment so the
 * tokens never leave the browser (no proxy / CDN access log records the
 * fragment). The SPA's `/auth/github/complete` page consumes this and
 * persists the tokens to localStorage.
 *
 * Returns `null` for any malformed fragment so callers can render a
 * single "didn't complete" branch instead of guarding each missing
 * field individually.
 */
export type AuthFragment = {
  accessToken: string;
  refreshToken: string;
  next: string;
};

export function parseAuthFragment(rawHash: string): AuthFragment | null {
  const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access");
  const refreshToken = params.get("refresh");
  if (!accessToken || !refreshToken) return null;
  // `next` is optional — fall back to root rather than rejecting; the
  // server always populates it but a forward-compat client should
  // tolerate either shape.
  const next = params.get("next") ?? "/";
  return { accessToken, refreshToken, next };
}
