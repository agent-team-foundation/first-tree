import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { protectOAuthStateNonce } from "../api/auth/oauth-cookie.js";
import { oidcRoutes } from "../api/auth/oidc.js";
import { signOAuthState } from "../services/oauth-state.js";

describe("OIDC callback security", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  it("clears cookies on provider error with valid state", async () => {
    const jwtSecret = "test-jwt-secret-key-for-vitest";
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "oidc-required",
        oidc: {
          issuer: "https://idp.test",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
        secrets: {
          jwtSecret,
          encryptionKey,
        },
      },
    });
    await app.register(oidcRoutes);
    await app.ready();

    try {
      // Create valid OAuth state
      const { token, nonce } = await signOAuthState(jwtSecret, "/", {
        provider: "oidc",
        intent: "sign-in",
        oidcNonce: "test-oidc-nonce",
      });
      const stateCookie = `oauth_state_nonce=${encodeURIComponent(protectOAuthStateNonce(nonce, encryptionKey))}`;
      const pkcePayload = JSON.stringify({ nonce, verifier: "test-verifier" });
      const pkceCookie = `oidc_pkce=${encodeURIComponent(protectOAuthStateNonce(pkcePayload, encryptionKey))}`;

      const callback = await app.inject({
        method: "GET",
        url: `/callback?error=access_denied&state=${encodeURIComponent(token)}`,
        headers: { cookie: `${stateCookie}; ${pkceCookie}` },
      });
      expect(callback.statusCode).toBe(302);

      const setCookieHeaders = callback.headers["set-cookie"];
      expect(setCookieHeaders).toBeDefined();
      const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

      // Both state and PKCE cookies should be cleared (Max-Age=0) when state is valid
      expect(
        cookies.some((c) => typeof c === "string" && c.includes("oauth_state_nonce") && c.includes("Max-Age=0")),
      ).toBe(true);
      expect(cookies.some((c) => typeof c === "string" && c.includes("oidc_pkce") && c.includes("Max-Age=0"))).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("does NOT clear cookies on malformed callback without valid state (prevents attack)", async () => {
    // A request with no code (malformed) and invalid/missing state must NOT clear cookies.
    // Clearing cookies without proven state ownership would allow an attacker to
    // terminate an unrelated active OIDC flow.
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "oidc-required",
        oidc: {
          issuer: "https://idp.test",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
    });
    await app.register(oidcRoutes);
    await app.ready();

    try {
      const callback = await app.inject({
        method: "GET",
        url: "/callback?state=invalid",
      });
      expect(callback.statusCode).toBe(302);

      const setCookieHeaders = callback.headers["set-cookie"];
      const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];

      // With invalid state, cookies must NOT be expired — the request doesn't own them
      expect(cookies.some((c) => c && c.includes("oauth_state_nonce") && c.includes("Max-Age=0"))).toBe(false);
      expect(cookies.some((c) => c && c.includes("oidc_pkce") && c.includes("Max-Age=0"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("preserves next parameter through error path", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "oidc-required",
        oidc: {
          issuer: "https://idp.test",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
    });
    await app.register(oidcRoutes);
    await app.ready();

    try {
      const callback = await app.inject({
        method: "GET",
        url: "/callback?error=access_denied",
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toMatch(/auth\/complete#.*error=provider-exchange-failed/);
      // Default next should be present
      expect(callback.headers.location).toMatch(/next=/);
    } finally {
      await app.close();
    }
  });

  it("includes explicit provider=oidc in fragment", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "oidc-required",
        oidc: {
          issuer: "https://idp.test",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
    });
    await app.register(oidcRoutes);
    await app.ready();

    try {
      const callback = await app.inject({
        method: "GET",
        url: "/callback?error=access_denied",
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toMatch(/provider=oidc/);
    } finally {
      await app.close();
    }
  });
});
