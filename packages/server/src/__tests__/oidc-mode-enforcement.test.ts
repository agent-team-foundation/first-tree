import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { googleOauthRoutes } from "../api/auth/google.js";
import { githubOauthRoutes } from "../api/auth/github.js";

describe("OIDC mode enforcement", () => {
  it("Google /start returns 403 when authMode=oidc-required", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "oidc-required",
        oauth: {
          google: {
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
          },
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        server: { publicUrl: undefined },
      },
    });
    await app.register(googleOauthRoutes);
    await app.ready();

    try {
      const start = await app.inject({ method: "GET", url: "/start" });
      expect(start.statusCode).toBe(403);
      expect(start.json<{ code: string }>().code).toBe("sign-in-method-disabled");
    } finally {
      await app.close();
    }
  });

  it("Google /start succeeds when authMode=standard", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "standard",
        oauth: {
          google: {
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
          },
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        server: { publicUrl: "https://test.example.com" },
      },
    });
    await app.register(googleOauthRoutes);
    await app.ready();

    try {
      const start = await app.inject({ method: "GET", url: "/start" });
      expect(start.statusCode).toBe(302);
      expect(start.headers.location).toMatch(/accounts\.google\.com/);
    } finally {
      await app.close();
    }
  });

  it("GitHub /start returns 403 when authMode=oidc-required", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "oidc-required",
        oauth: {
          githubApp: {
            appId: "123",
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
            privateKey: "test-private-key",
            webhookSecret: "test-webhook-secret",
            slug: "test-slug",
          },
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        server: { publicUrl: undefined },
      },
    });
    await app.register(githubOauthRoutes);
    await app.ready();

    try {
      const start = await app.inject({ method: "GET", url: "/start" });
      expect(start.statusCode).toBe(403);
      expect(start.json<{ code: string }>().code).toBe("sign-in-method-disabled");
    } finally {
      await app.close();
    }
  });

  it("GitHub /start succeeds when authMode=standard", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        authMode: "standard",
        oauth: {
          githubApp: {
            appId: "123",
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
            privateKey: "test-private-key",
            webhookSecret: "test-webhook-secret",
            slug: "test-slug",
          },
        },
        secrets: {
          jwtSecret: "test-jwt-secret-key-for-vitest",
          encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        server: { publicUrl: "https://test.example.com" },
      },
    });
    await app.register(githubOauthRoutes);
    await app.ready();

    try {
      const start = await app.inject({ method: "GET", url: "/start" });
      expect(start.statusCode).toBe(302);
      expect(start.headers.location).toMatch(/github\.com/);
    } finally {
      await app.close();
    }
  });
});
