/**
 * Mint a fresh user JWT pair via the server's `dev-callback` GitHub OAuth
 * bypass. Used by the dev-user seed (`setup-devuser.ts`) and by tests that
 * need a second-or-third user to exercise multi-user surfaces (e.g.
 * `client-claim.e2e`).
 *
 * The route only exists when the server was booted with
 * `FIRST_TREE_DEV_CALLBACK_ENABLED=1` (e2e:up does this; vitest
 * globalSetup does NOT today, so this helper is only safe to call in the
 * `e2e:up` flow OR inside tests that opt into spawning their own
 * dev-callback-enabled server).
 *
 * Important: dev-callback maps `githubId` → user 1:1. Reusing the same
 * `githubId` returns the same user; callers that need an isolated user must
 * use distinct ids. The seed defaults `githubId=1, login=devuser`; tests
 * should pick id ≥ 2 with a unique login to avoid colliding with the seed.
 */

export type DevCallbackTokens = {
  accessToken: string;
  refreshToken: string;
};

export type MintDevUserOptions = {
  serverBaseUrl: string;
  githubId: number;
  login: string;
  displayName?: string;
};

export async function mintDevUserTokens(opts: MintDevUserOptions): Promise<DevCallbackTokens> {
  const url = new URL("/api/v1/auth/github/dev-callback", opts.serverBaseUrl);
  url.searchParams.set("githubId", String(opts.githubId));
  url.searchParams.set("login", opts.login);
  url.searchParams.set("displayName", opts.displayName ?? opts.login);
  const res = await fetch(url, { redirect: "manual" });
  if (res.status !== 302) {
    throw new Error(
      `dev-callback expected 302, got ${res.status}: ${await res.text().catch(() => "<no body>")}. ` +
        "Check that the server was booted with FIRST_TREE_DEV_CALLBACK_ENABLED=1.",
    );
  }
  const location = res.headers.get("location");
  if (!location) throw new Error("dev-callback returned 302 without Location header");
  const hashIdx = location.indexOf("#");
  if (hashIdx < 0) throw new Error(`dev-callback Location has no fragment: ${location}`);
  const frag = new URLSearchParams(location.slice(hashIdx + 1));
  const accessToken = frag.get("access");
  const refreshToken = frag.get("refresh");
  if (!accessToken || !refreshToken) {
    throw new Error(`dev-callback fragment missing access/refresh: ${location}`);
  }
  return { accessToken, refreshToken };
}
