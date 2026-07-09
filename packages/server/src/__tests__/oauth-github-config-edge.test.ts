import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { githubOauthRoutes } from "../api/auth/github.js";

describe("GitHub OAuth route config edges", () => {
  it("returns 503 from start and callback when the GitHub App is not configured", async () => {
    const app = Object.assign(Fastify({ logger: false }), {
      config: {
        oauth: {},
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
      expect(start.statusCode).toBe(503);
      expect(start.json<{ error: string }>().error).toMatch(/not configured/i);

      const callback = await app.inject({ method: "GET", url: "/callback" });
      expect(callback.statusCode).toBe(503);
      expect(callback.json<{ error: string }>().error).toMatch(/not configured/i);
    } finally {
      await app.close();
    }
  });
});
