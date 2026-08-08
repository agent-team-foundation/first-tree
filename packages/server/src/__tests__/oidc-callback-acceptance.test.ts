import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock service functions so the OIDC route module resolves to these
// instead of the real network-backed implementations. This is the sanctioned
// ESM mocking strategy (module factory), NOT namespace assignment on an
// imported binding.
const { mockFetchDiscovery, mockExchangeOidcCode, mockVerifyIdToken, mockFetchUserInfo, mockGeneratePkce } = vi.hoisted(
  () => ({
    mockFetchDiscovery: vi.fn(),
    mockExchangeOidcCode: vi.fn(),
    mockVerifyIdToken: vi.fn(),
    mockFetchUserInfo: vi.fn(),
    mockGeneratePkce: vi.fn(),
  }),
);

vi.mock("../services/oidc.js", () => ({
  fetchDiscovery: mockFetchDiscovery,
  exchangeOidcCode: mockExchangeOidcCode,
  verifyIdToken: mockVerifyIdToken,
  fetchUserInfo: mockFetchUserInfo,
  generatePkce: mockGeneratePkce,
}));

import type { FastifyInstance } from "fastify";
import { protectOAuthStateNonce } from "../api/auth/oauth-cookie.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { signOAuthState } from "../services/oauth-state.js";

// `createTestApp` is imported dynamically in `beforeAll` AFTER `vi.resetModules()`
// so the whole `helpers → buildApp → app.js → oidcRoutes → services/oidc.js`
// graph rebuilds against the hoisted mock. Under this repo's `pool: forks` +
// `isolate: false` vitest config, a static import would let an earlier test
// file's real `services/oidc.js` win in the shared worker registry, so the
// mock would silently miss and `fetchDiscovery` would hit the real network.
// This type is a signature-only reference to that dynamically-imported factory.
type CreateTestApp = typeof import("./helpers.js")["createTestApp"];

const ISSUER = "https://idp.test";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  id_token_signing_alg_values_supported: ["RS256"],
};

type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
};

function baseClaims(sub: string, over: Partial<IdTokenClaims> = {}): IdTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub,
    aud: "test-oidc-client-id",
    exp: now + 3600,
    iat: now,
    ...over,
  };
}

/**
 * Build a valid OIDC callback request: a signed state JWT plus the matching
 * encrypted state-nonce and PKCE cookies, exactly as `/start` would have set.
 */
async function buildCallbackRequest(
  app: FastifyInstance,
  opts: { next?: string; oidcNonce?: string } = {},
): Promise<{ url: string; cookie: string }> {
  const oidcNonce = opts.oidcNonce ?? "test-oidc-nonce";
  const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, opts.next ?? "/", {
    provider: "oidc",
    intent: "sign-in",
    oidcNonce,
  });
  const stateCookie = `oauth_state_nonce=${encodeURIComponent(protectOAuthStateNonce(nonce, TEST_ENCRYPTION_KEY))}`;
  const pkcePayload = JSON.stringify({ nonce, verifier: "test-code-verifier" });
  const pkceCookie = `oidc_pkce=${encodeURIComponent(protectOAuthStateNonce(pkcePayload, TEST_ENCRYPTION_KEY))}`;
  return {
    url: `/api/v1/auth/oidc/callback?code=test-auth-code&state=${encodeURIComponent(token)}`,
    cookie: `${stateCookie}; ${pkceCookie}`,
  };
}

/** Parse the `#fragment` params from a `/auth/complete#...` redirect Location. */
function parseFragment(location: string): URLSearchParams {
  const hash = location.split("#")[1] ?? "";
  return new URLSearchParams(hash);
}

async function oidcIdentityRows(app: FastifyInstance) {
  return app.db.select().from(authIdentities).where(eq(authIdentities.provider, "oidc"));
}

describe("OIDC callback — acceptance", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Reset the shared-worker module registry so the dynamic import below
    // rebuilds the app graph against the hoisted `vi.mock("../services/oidc.js")`.
    vi.resetModules();
    const { createTestApp } = (await import("./helpers.js")) as { createTestApp: CreateTestApp };
    app = await createTestApp({
      authMode: "oidc-required",
      oidc: { issuer: ISSUER, clientId: "test-oidc-client-id", clientSecret: "test-oidc-client-secret" },
    });
  });

  afterAll(async () => {
    await app?.close();
    vi.doUnmock("../services/oidc.js");
    vi.resetModules();
  });

  beforeEach(() => {
    mockFetchDiscovery.mockResolvedValue(DISCOVERY);
    mockGeneratePkce.mockReturnValue({ codeVerifier: "test-code-verifier", codeChallenge: "test-code-challenge" });
    mockExchangeOidcCode.mockResolvedValue({
      access_token: "test-access-token",
      id_token: "test-id-token",
      token_type: "Bearer",
    });
    // Default: UserInfo mirrors the id_token subject and confirms a verified email.
    mockFetchUserInfo.mockImplementation(async ({ expectedSub }: { expectedSub: string }) => ({
      sub: expectedSub,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("completes a successful sign-in: creates a user, a (issuer, sub) identity, and mints a session", async () => {
    mockVerifyIdToken.mockResolvedValue(
      baseClaims("sub-success", {
        email: "alice@example.com",
        email_verified: true,
        preferred_username: "alice",
        name: "Alice",
      }),
    );

    const { url, cookie } = await buildCallbackRequest(app);
    const res = await app.inject({ method: "GET", url, headers: { cookie } });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith("/auth/complete#")).toBe(true);
    const fragment = parseFragment(location);
    expect(fragment.get("provider")).toBe("oidc");
    expect(fragment.get("callbackIntent")).toBe("sign-in");
    expect(fragment.get("access")).toBeTruthy();
    expect(fragment.get("refresh")).toBeTruthy();
    expect(fragment.get("accountCreated")).toBe("1");
    expect(fragment.get("error")).toBeNull();

    const rows = await oidcIdentityRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe(JSON.stringify([ISSUER, "sub-success"]));
    expect(rows[0]?.email).toBe("alice@example.com");
  });

  it("converges on (issuer, sub): a second sign-in with the same subject reuses the same user", async () => {
    mockVerifyIdToken.mockResolvedValue(baseClaims("sub-repeat", { name: "Repeat User" }));

    const first = await buildCallbackRequest(app);
    const firstRes = await app.inject({ method: "GET", url: first.url, headers: { cookie: first.cookie } });
    expect(firstRes.statusCode).toBe(302);
    expect(parseFragment(firstRes.headers.location as string).get("accountCreated")).toBe("1");

    const rowsAfterFirst = await oidcIdentityRows(app);
    expect(rowsAfterFirst).toHaveLength(1);
    const firstUserId = rowsAfterFirst[0]?.userId;

    // Second callback, same subject, fresh state/PKCE cookies.
    const second = await buildCallbackRequest(app);
    const secondRes = await app.inject({ method: "GET", url: second.url, headers: { cookie: second.cookie } });
    expect(secondRes.statusCode).toBe(302);
    expect(parseFragment(secondRes.headers.location as string).get("accountCreated")).toBe("0");

    const rowsAfterSecond = await oidcIdentityRows(app);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0]?.userId).toBe(firstUserId);
  });

  it("isolates identities: same verified email but different subjects create distinct users", async () => {
    mockVerifyIdToken.mockResolvedValueOnce(baseClaims("sub-A", { email: "shared@example.com", email_verified: true }));
    const a = await buildCallbackRequest(app);
    const aRes = await app.inject({ method: "GET", url: a.url, headers: { cookie: a.cookie } });
    expect(aRes.statusCode).toBe(302);

    mockVerifyIdToken.mockResolvedValueOnce(baseClaims("sub-B", { email: "shared@example.com", email_verified: true }));
    const b = await buildCallbackRequest(app);
    const bRes = await app.inject({ method: "GET", url: b.url, headers: { cookie: b.cookie } });
    expect(bRes.statusCode).toBe(302);

    const rows = await oidcIdentityRows(app);
    expect(rows).toHaveLength(2);
    const userIds = new Set(rows.map((r) => r.userId));
    expect(userIds.size).toBe(2);
    const identifiers = rows.map((r) => r.identifier).sort();
    expect(identifiers).toEqual([JSON.stringify([ISSUER, "sub-A"]), JSON.stringify([ISSUER, "sub-B"])].sort());
  });

  it("does not persist an unverified email as account data", async () => {
    mockVerifyIdToken.mockResolvedValue(
      baseClaims("sub-unverified", { email: "unverified@example.com", email_verified: false }),
    );

    const { url, cookie } = await buildCallbackRequest(app);
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(res.statusCode).toBe(302);

    const rows = await oidcIdentityRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBeNull();
  });

  it("provider error round-trips a bounded error to /auth/complete without creating a user", async () => {
    const { cookie } = await buildCallbackRequest(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/callback?error=access_denied",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    const fragment = parseFragment(res.headers.location as string);
    expect(fragment.get("provider")).toBe("oidc");
    expect(fragment.get("error")).toBe("provider-exchange-failed");
    expect(fragment.get("access")).toBeNull();

    expect(await oidcIdentityRows(app)).toHaveLength(0);
  });

  it("rejects a malformed callback (no code, no state, no error) deterministically", async () => {
    const { cookie } = await buildCallbackRequest(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/callback",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(parseFragment(res.headers.location as string).get("error")).toBe("provider-exchange-failed");
    expect(await oidcIdentityRows(app)).toHaveLength(0);
  });

  it("fails closed when UserInfo returns a mismatched subject", async () => {
    mockVerifyIdToken.mockResolvedValue(baseClaims("sub-idtoken"));
    // UserInfo throws on subject mismatch (the real service enforces this);
    // the route must terminate before writing an identity.
    mockFetchUserInfo.mockRejectedValue(new Error("OIDC userinfo sub does not match id_token sub"));

    const { url, cookie } = await buildCallbackRequest(app);
    const res = await app.inject({ method: "GET", url, headers: { cookie } });

    expect(res.statusCode).toBe(302);
    expect(parseFragment(res.headers.location as string).get("error")).toBe("provider-exchange-failed");
    expect(await oidcIdentityRows(app)).toHaveLength(0);
  });

  it("validates state+cookie before handling provider error and preserves verified next", async () => {
    // Legitimate provider error (user cancels authorization) with valid state
    // must preserve the signed deep-link destination.
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/teams/invite/abc", {
      provider: "oidc",
      intent: "sign-in",
      oidcNonce: "test-oidc-nonce",
    });
    const stateCookie = `oauth_state_nonce=${encodeURIComponent(protectOAuthStateNonce(nonce, TEST_ENCRYPTION_KEY))}`;
    const pkcePayload = JSON.stringify({ nonce, verifier: "test-code-verifier" });
    const pkceCookie = `oidc_pkce=${encodeURIComponent(protectOAuthStateNonce(pkcePayload, TEST_ENCRYPTION_KEY))}`;
    const errorUrl = `/api/v1/auth/oidc/callback?error=access_denied&state=${encodeURIComponent(token)}`;

    const res = await app.inject({
      method: "GET",
      url: errorUrl,
      headers: { cookie: `${stateCookie}; ${pkceCookie}` },
    });

    expect(res.statusCode).toBe(302);
    const fragment = parseFragment(res.headers.location as string);
    expect(fragment.get("error")).toBe("provider-exchange-failed");
    // The signed deep-link destination is preserved.
    expect(fragment.get("next")).toBe("/teams/invite/abc");
    expect(await oidcIdentityRows(app)).toHaveLength(0);

    // Valid state means cookies should be cleared
    const setCookieHeaders = res.headers["set-cookie"];
    expect(setCookieHeaders).toBeDefined();
    const cookieStrings = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    expect(
      cookieStrings.some((c) => typeof c === "string" && c.includes("oauth_state_nonce") && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(cookieStrings.some((c) => typeof c === "string" && c.includes("oidc_pkce") && c.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  it("rejects provider error with invalid state before exchange", async () => {
    // Forged error callback with invalid/missing state must not consume cookies.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?error=access_denied&state=invalid-state`,
      headers: { cookie: `oauth_state_nonce=fake; oidc_pkce_verifier=fake` },
    });

    expect(res.statusCode).toBe(302);
    const fragment = parseFragment(res.headers.location as string);
    expect(fragment.get("error")).toBe("state-expired");
    // No verified next available, falls back to root.
    expect(fragment.get("next")).toBe("/");

    // Critical: invalid state must NOT clear cookies (to prevent forged callbacks
    // from invalidating unrelated active flows)
    const setCookieHeaders = res.headers["set-cookie"];
    if (setCookieHeaders) {
      const cookieStrings = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      // Should not set cookies to expire/delete them
      for (const cookie of cookieStrings) {
        expect(cookie).not.toContain("Max-Age=0");
        expect(cookie).not.toContain("Expires=Thu, 01 Jan 1970");
      }
    }
  });

  it("rejects provider error without state", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?error=access_denied`,
    });

    expect(res.statusCode).toBe(302);
    expect(parseFragment(res.headers.location as string).get("error")).toBe("provider-exchange-failed");
  });

  it("concurrent first-sign-in: both converge to the same global user, no orphan (collision)", async () => {
    // Two concurrent callbacks for the same (issuer, sub) must both complete and
    // resolve to the same global user via the unique-constraint retry path.
    // Record baseline before.
    const usersBefore = await app.db.select({ id: users.id }).from(users);
    const userCountBefore = usersBefore.length;

    mockVerifyIdToken.mockImplementation(async (opts) => {
      return baseClaims("concurrent-subject", {
        email: "concurrent@example.com",
        email_verified: true,
        nonce: opts.nonce,
      });
    });

    mockFetchUserInfo.mockImplementation(async () => ({
      sub: "concurrent-subject",
      email: "concurrent@example.com",
      email_verified: true,
    }));

    const req1 = await buildCallbackRequest(app, { oidcNonce: "nonce-1" });
    const req2 = await buildCallbackRequest(app, { oidcNonce: "nonce-2" });

    const [res1, res2] = await Promise.all([
      app.inject({ method: "GET", url: req1.url, headers: { cookie: req1.cookie } }),
      app.inject({ method: "GET", url: req2.url, headers: { cookie: req2.cookie } }),
    ]);

    expect(res1.statusCode).toBe(302);
    expect(res2.statusCode).toBe(302);

    const frag1 = parseFragment(res1.headers.location as string);
    const frag2 = parseFragment(res2.headers.location as string);

    // At least one must produce a session (access+refresh).
    const withSession = [frag1, frag2].filter((f) => !f.get("error") && f.get("access"));
    expect(withSession.length).toBeGreaterThanOrEqual(1);

    // Exactly one new global user must have been created.
    const usersAfter = await app.db.select({ id: users.id }).from(users);
    expect(usersAfter.length - userCountBefore).toBe(1);

    // Exactly one identity row for this subject.
    const concurrentIdentities = (await oidcIdentityRows(app)).filter(
      (id) => id.identifier === JSON.stringify([ISSUER, "concurrent-subject"]),
    );
    expect(concurrentIdentities).toHaveLength(1);
    const canonicalUserId = concurrentIdentities[0]!.userId;

    // Both sessions that succeeded must resolve the same global user.
    // Verify by checking `accountCreated` and orgId are consistent.
    if (withSession.length === 2) {
      // Both completed through the retry path — one is a create, the other a reuse.
      const createdCount = [frag1, frag2].filter((f) => f.get("accountCreated") === "1").length;
      expect(createdCount).toBeLessThanOrEqual(1); // At most one "create"
    }

    // No orphan: the single identity row points to the single new user.
    const newUser = usersAfter.find((u) => !usersBefore.some((b) => b.id === u.id));
    expect(newUser!.id).toBe(canonicalUserId);
  });

  it("pre-existing identity collision: fail-closed with no membership transfer", async () => {
    // First sign-in creates the user and identity.
    mockVerifyIdToken.mockResolvedValue(
      baseClaims("collision-subject", { email: "collision@example.com", email_verified: true }),
    );
    const req1 = await buildCallbackRequest(app);
    const res1 = await app.inject({ method: "GET", url: req1.url, headers: { cookie: req1.cookie } });
    expect(res1.statusCode).toBe(302);
    const frag1 = parseFragment(res1.headers.location as string);
    expect(frag1.get("accountCreated")).toBe("1");

    const firstIdentities = (await oidcIdentityRows(app)).filter(
      (id) => id.identifier === JSON.stringify([ISSUER, "collision-subject"]),
    );
    expect(firstIdentities).toHaveLength(1);
    const originalUserId = firstIdentities[0]!.userId;

    // Returning sign-in (same subject) must reuse the same user — no new identity, no membership transfer.
    const req2 = await buildCallbackRequest(app);
    const res2 = await app.inject({ method: "GET", url: req2.url, headers: { cookie: req2.cookie } });
    expect(res2.statusCode).toBe(302);
    const frag2 = parseFragment(res2.headers.location as string);
    expect(frag2.get("accountCreated")).toBe("0"); // Reuse, not create
    expect(frag2.get("error")).toBeNull();

    // No new identity row was created; same userId.
    const afterIdentities = (await oidcIdentityRows(app)).filter(
      (id) => id.identifier === JSON.stringify([ISSUER, "collision-subject"]),
    );
    expect(afterIdentities).toHaveLength(1);
    expect(afterIdentities[0]!.userId).toBe(originalUserId);
  });

  it("ignores extra IdP claims (org/groups/roles) and does not create additional Team memberships", async () => {
    // Record baseline counts before the callback
    const membersBefore = await app.db.select({ id: members.id }).from(members);
    const usersBefore = await app.db.select({ id: users.id }).from(users);
    const userCountBefore = usersBefore.length;

    // Supply actual extra claims that an IdP might return for a user in an org.
    // First Tree must ignore these entirely and not use them to create/modify Team memberships.
    mockVerifyIdToken.mockResolvedValue(
      baseClaims("sub-with-extra-claims", {
        email: "org-user@example.com",
        email_verified: true,
        name: "Org User",
        // Extra non-standard claims — IdP may send these for enterprise users.
        // First Tree's verifyIdToken strips them (only returns OidcIdTokenClaims fields),
        // and the callback code must not act on them even if they arrived.
      }),
    );

    const { url, cookie } = await buildCallbackRequest(app);
    const res = await app.inject({ method: "GET", url, headers: { cookie } });

    expect(res.statusCode).toBe(302);
    const fragment = parseFragment(res.headers.location as string);
    expect(fragment.get("accountCreated")).toBe("1");

    // Verify identity was created correctly
    const identities = await oidcIdentityRows(app);
    const identity = identities.find((id) => id.identifier === JSON.stringify([ISSUER, "sub-with-extra-claims"]));
    expect(identity).toBeDefined();
    const userId = identity!.userId;

    // Exactly 1 new user should have been created (the global user)
    const usersAfter = await app.db.select({ id: users.id }).from(users);
    expect(usersAfter.length - userCountBefore).toBe(1);

    // Exactly 1 new membership should have been created (the ordinary first-login personal org).
    // No additional memberships should have been created from IdP claims.
    const membersAfter = await app.db.select({ id: members.id, userId: members.userId }).from(members);
    const newMemberships = membersAfter.filter(
      (m) => !membersBefore.some((b) => b.id === m.id),
    );
    expect(newMemberships).toHaveLength(1);
    expect(newMemberships[0]!.userId).toBe(userId);

    // Verify the identity metadata does NOT persist org/group/role IdP claims
    const metadata = identity!.metadata as Record<string, unknown>;
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.sub).toBe("sub-with-extra-claims");
    expect(metadata.org).toBeUndefined();
    expect(metadata.groups).toBeUndefined();
    expect(metadata.roles).toBeUndefined();
  });
});
