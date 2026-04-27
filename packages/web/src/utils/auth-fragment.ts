import { sanitizeNextPath } from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Parse the URL fragment delivered by the server's OAuth callback redirect.
 * Server packs `?access=…&refresh=…&next=…` into the fragment so the
 * tokens never leave the browser (no proxy / CDN access log records the
 * fragment). The SPA's `/auth/github/complete` page consumes this and
 * persists the tokens to localStorage.
 *
 * `next` is sanitised against the same `SAFE_NEXT_PATH` whitelist the
 * server's `/start` route applies. Without the client-side check, a
 * crafted link like `/auth/github/complete#access=…&refresh=…&next=//evil`
 * could land the user off-origin AFTER persisting the (server-controlled)
 * tokens — token-fixation via fragment. The whitelist rejects that and
 * silently downgrades the malicious value to `/`.
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
  return {
    accessToken,
    refreshToken,
    next: sanitizeNextPath(params.get("next")),
  };
}
