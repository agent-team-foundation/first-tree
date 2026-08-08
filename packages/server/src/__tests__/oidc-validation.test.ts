import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(fetchDiscovery("https://idp.test")).rejects.toThrow(/must use HTTPS in production/);
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
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

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
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(
      exchangeOidcCode({
        tokenEndpoint: "https://idp.test/token",
        code: "auth-code",
        redirectUri: "https://app.test/callback",
        clientId: "client-id",
        clientSecret: "client-secret",
        codeVerifier: "verifier",
      }),
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
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(
      exchangeOidcCode({
        tokenEndpoint: "https://idp.test/token",
        code: "auth-code",
        redirectUri: "https://app.test/callback",
        clientId: "client-id",
        clientSecret: "client-secret",
        codeVerifier: "verifier",
      }),
    ).rejects.toThrow(/missing access_token/);
  });

  it("rejects discovery with missing id_token_signing_alg_values_supported", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.test",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
        // missing id_token_signing_alg_values_supported
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(fetchDiscovery("https://idp.test")).rejects.toThrow(
      /must provide id_token_signing_alg_values_supported/,
    );
  });

  it("rejects discovery with unsupported signing algorithms", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.test",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
        id_token_signing_alg_values_supported: ["HS256", "none"],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(fetchDiscovery("https://idp.test")).rejects.toThrow(/advertises no supported signing algorithms/);
  });

  it("accepts discovery with mixed algorithms and returns only supported ones", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.test",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
        id_token_signing_alg_values_supported: ["HS256", "RS256", "ES256", "none"],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const discovery = await fetchDiscovery("https://idp.test");
    expect(discovery.id_token_signing_alg_values_supported).toEqual(["RS256", "ES256"]);
  });

  it("handles issuer with trailing slash correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.test/",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const discovery = await fetchDiscovery("https://idp.test/");
    expect(discovery.issuer).toBe("https://idp.test/");
    // Verify the discovery URL was constructed correctly (without double slash)
    expect(mockFetch).toHaveBeenCalledWith("https://idp.test/.well-known/openid-configuration", expect.any(Object));
  });

  it("handles issuer with path and trailing slash correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.test/auth/realms/myrealm/",
        authorization_endpoint: "https://idp.test/auth/realms/myrealm/authorize",
        token_endpoint: "https://idp.test/auth/realms/myrealm/token",
        jwks_uri: "https://idp.test/auth/realms/myrealm/jwks",
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const discovery = await fetchDiscovery("https://idp.test/auth/realms/myrealm/");
    expect(discovery.issuer).toBe("https://idp.test/auth/realms/myrealm/");
    // Verify the discovery URL was constructed correctly (without double slash)
    expect(mockFetch).toHaveBeenCalledWith(
      "https://idp.test/auth/realms/myrealm/.well-known/openid-configuration",
      expect.any(Object),
    );
  });
});
