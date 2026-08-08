import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { protectOAuthStateNonce } from "../api/auth/oauth-cookie.js";
import { signOAuthState } from "../services/oauth-state.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

const ISSUER = "https://idp.test";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Parse the `#fragment` params from an `/auth/complete#...` redirect Location. */
function parseFragment(location: string): URLSearchParams {
  const hash = location.split("#")[1] ?? "";
  return new URLSearchParams(hash);
}

/**
 * Build a signed Google callback request. `intent` is deliberately optional so
 * a caller can exercise the legacy shape (a valid signed state with no intent),
 * which #2188 requires be treated as sign-in and rejected in oidc-required mode.
 */
async function buildGoogleCallback(
  app: FastifyInstance,
  opts: { intent?: "sign-in" | "link" | "unlink"; oidcNonce?: string } = {},
): Promise<{ url: string; cookie: string }> {
  const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/", {
    provider: "google",
    ...(opts.intent ? { intent: opts.intent } : {}),
    oidcNonce: opts.oidcNonce ?? "google-nonce",
  });
  const cookie = `oauth_state_nonce=${encodeURIComponent(protectOAuthStateNonce(nonce, TEST_ENCRYPTION_KEY))}`;
  return {
    url: `/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(token)}`,
    cookie,
  };
}

describe("oidc-required mode — bootstrap advertised providers", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp({
      authMode: "oidc-required",
      googleOAuth: true,
      oidc: { issuer: ISSUER, clientId: "test-oidc-client-id", clientSecret: "test-oidc-client-secret" },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("advertises only OIDC as a sign-in provider even when Google/GitHub creds exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authMode).toBe("oidc-required");
    expect(body.authProviders).toEqual({ google: false, github: false, oidc: true });
  });
});

describe("standard mode — bootstrap keeps OIDC dormant", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp({ authMode: "standard", googleOAuth: true });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("does not advertise OIDC and reports configured standard providers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authProviders).toEqual({ google: true, github: true, oidc: false });
  });
});

describe("standard mode with dormant OIDC config — complete dormancy", () => {
  // Spy on fetch BEFORE app creation to capture any boot-time OIDC network
  // calls (discovery, JWKS init). The spy must be active when createTestApp
  // runs so the full boot + request path is observable.
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    fetchSpy = vi.fn().mockRejectedValue(new Error("fetch should not be called in dormant mode"));
    vi.stubGlobal("fetch", fetchSpy);

    app = await createTestApp({
      authMode: "standard",
      googleOAuth: true,
      oidc: { issuer: ISSUER, clientId: "dormant-client-id", clientSecret: "dormant-secret" },
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
  });

  it("returns 404 for OIDC start route when dormant", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for OIDC callback route when dormant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/callback?code=test&state=test",
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not advertise OIDC in bootstrap even with config present", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authProviders.oidc).toBe(false);
  });

  it("makes zero OIDC network calls (discovery/JWKS/userinfo) through boot and dormant routes", async () => {
    // The fetchSpy was installed before app creation (in beforeAll), so it
    // captured any boot-time OIDC calls as well. Exercise the dormant routes
    // and assert no discovery, JWKS, or userinfo URL was fetched at any point.
    await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
    await app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });
    await app.inject({ method: "GET", url: "/api/v1/auth/oidc/callback?code=test&state=test" });

    const oidcFetchCalls = fetchSpy.mock.calls.filter((args: unknown[]) => {
      const url = args[0];
      return (
        typeof url === "string" &&
        (url.includes("/.well-known") || url.includes("/jwks") || url.includes("/userinfo") || url.includes("idp."))
      );
    });
    expect(oidcFetchCalls).toHaveLength(0);
  });
});

describe("oidc-required mode — Account Settings capability split", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp({
      authMode: "oidc-required",
      googleOAuth: true,
      oidc: { issuer: ISSUER, clientId: "test-oidc-client-id", clientSecret: "test-oidc-client-secret" },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("keeps GitHub linkable (capability) but Google unavailable in oidc-required mode", async () => {
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/auth-providers",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const providers: Array<{ provider: string; available: boolean }> = res.json().providers;
    const google = providers.find((p) => p.provider === "google");
    const github = providers.find((p) => p.provider === "github");
    // Google is a sign-in-only provider — unavailable when OIDC is the sign-in method.
    expect(google?.available).toBe(false);
    // GitHub availability follows the configured GitHub App (capability linking),
    // independent of the sign-in mode.
    expect(github?.available).toBe(true);
    // The linkable-provider list never surfaces oidc as an Account Settings row.
    expect(providers.some((p) => p.provider === "oidc")).toBe(false);
  });
});

describe("oidc-required mode — Google sign-in is disabled at every entry", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp({
      authMode: "oidc-required",
      googleOAuth: true,
      oidc: { issuer: ISSUER, clientId: "test-oidc-client-id", clientSecret: "test-oidc-client-secret" },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("rejects Google /start with sign-in-method-disabled", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("sign-in-method-disabled");
  });

  it("rejects a legacy Google callback (no intent) before provider exchange", async () => {
    const { url, cookie } = await buildGoogleCallback(app, {});
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(parseFragment(res.headers.location as string).get("error")).toBe("sign-in-method-disabled");
  });

  it("rejects an explicit sign-in Google callback before provider exchange", async () => {
    const { url, cookie } = await buildGoogleCallback(app, { intent: "sign-in" });
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(parseFragment(res.headers.location as string).get("error")).toBe("sign-in-method-disabled");
  });
});

describe("standard mode — password login remains available", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp({ authMode: "standard" });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("does not disable password login when OIDC is dormant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "nonexistent-user", password: "wrong-password" },
    });
    // The mode guard must NOT fire in standard mode; the request instead fails
    // on real credential validation (not a 403 sign-in-method-disabled).
    expect(res.statusCode).not.toBe(403);
  });
});
