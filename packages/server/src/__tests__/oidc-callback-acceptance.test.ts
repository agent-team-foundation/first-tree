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
});
