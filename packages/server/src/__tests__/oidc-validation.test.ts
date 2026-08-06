import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { exchangeOidcCode, fetchDiscovery } from "../services/oidc.js";

describe("OIDC validation", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  // Note: ID token claim validation (sub, iat, exp, azp, nonce) is tested by
  // the jose library itself. Our tests focus on runtime checks we added.

  it("rejects discovery with non-HTTPS endpoints in production", async () => {
    process.env.NODE_ENV = "production";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.test",
        authorization_endpoint: "http://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
      }),
    });
    global.fetch = mockFetch as any;

    await expect(fetchDiscovery("https://idp.test")).rejects.toThrow(/must use HTTPS/);
  });

  it("accepts discovery with HTTP endpoints in non-production", async () => {
    process.env.NODE_ENV = "development";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "http://localhost:8080",
        authorization_endpoint: "http://localhost:8080/authorize",
        token_endpoint: "http://localhost:8080/token",
        jwks_uri: "http://localhost:8080/jwks",
      }),
    });
    global.fetch = mockFetch as any;

    const discovery = await fetchDiscovery("http://localhost:8080");
    expect(discovery.authorization_endpoint).toBe("http://localhost:8080/authorize");
  });

  it("validates token exchange response structure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "test-access",
        id_token: "test-id",
        // missing token_type
      }),
    });
    global.fetch = mockFetch as any;

    await expect(
      exchangeOidcCode({
        tokenEndpoint: "https://idp.test/token",
        code: "auth-code",
        redirectUri: "https://app.test/callback",
        clientId: "client-id",
        clientSecret: "client-secret",
        codeVerifier: "verifier",
      })
    ).rejects.toThrow(/missing token_type/);
  });

  it("validates token exchange includes access_token and id_token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token_type: "Bearer",
        // missing access_token and id_token
      }),
    });
    global.fetch = mockFetch as any;

    await expect(
      exchangeOidcCode({
        tokenEndpoint: "https://idp.test/token",
        code: "auth-code",
        redirectUri: "https://app.test/callback",
        clientId: "client-id",
        clientSecret: "client-secret",
        codeVerifier: "verifier",
      })
    ).rejects.toThrow(/missing access_token/);
  });
});
