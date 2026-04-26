import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { users } from "../db/schema/users.js";
import { createTestAdmin } from "./helpers.js";

/**
 * Build an app with a fixed (well-known) port so the local-bootstrap Host
 * check has a deterministic expected value. `inject` is in-memory — the
 * server never actually binds — but the route handler captures
 * `config.server.port` at registration time to validate the Host header.
 */
async function buildAppWithPort(port: number): Promise<FastifyInstance> {
  const config: Config = {
    database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
    server: { port, host: "127.0.0.1" },
    secrets: {
      jwtSecret: process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    github: { webhookSecret: "test-webhook-secret", allowedOrg: "test-org" },
    rateLimit: { max: 10000, loginMax: 10000, webhookMax: 10000 },
    observability: { logging: { level: "error", format: "json", bridgeToSpanLevel: "off" } },
    instanceId: "test-local-bootstrap",
  };
  const app = await buildApp(config);
  await app.ready();
  return app;
}

describe("POST /api/v1/auth/local-bootstrap", () => {
  const PORT = 8000;
  const HOST = `127.0.0.1:${PORT}`;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAppWithPort(PORT);
  });
  afterAll(async () => {
    await app?.close();
  });

  describe("happy path", () => {
    it("mints an access + refresh token pair for the local admin", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(body.refreshToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it("accepts the localhost form of the Host header", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: `localhost:${PORT}` },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
    });

    it("accepts the mixed-case localhost form of the Host header", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: `LOCALHOST:${PORT}` },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
    });

    it("accepts ::1 as a loopback IP (Node IPv6 form)", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "::1",
      });
      expect(res.statusCode).toBe(200);
    });

    it("accepts the IPv4-mapped IPv6 loopback form ::ffff:127.0.0.1", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "::ffff:127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("admin-resolution failures", () => {
    it("returns 401 when no admin exists yet", async () => {
      // Truncated by setup.ts beforeEach — no createTestAdmin call here.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 when the admin user is suspended", async () => {
      const admin = await createTestAdmin(app);
      await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, admin.userId));
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("loopback-IP gate", () => {
    it("rejects requests from non-loopback IPv4 addresses", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "10.0.0.5",
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects requests from non-loopback IPv6 addresses", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST },
        remoteAddress: "fe80::1",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("forwarded-header gate", () => {
    it.each([
      ["x-forwarded-for", "127.0.0.1"],
      ["x-forwarded-proto", "https"],
      ["x-forwarded-host", "evil.com"],
      ["x-forwarded-port", "443"],
      ["forwarded", "for=127.0.0.1;proto=https"],
    ])("rejects requests carrying %s", async (header, value) => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: HOST, [header]: value },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("host-header gate (DNS-rebinding defence)", () => {
    it("rejects entirely-unrelated host names", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: "evil.com" },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects suffix attacks like 127.0.0.1:8000.evil.com", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: `${HOST}.evil.com` },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects port substitution (different bound port)", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: "127.0.0.1:8001" },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects bare 127.0.0.1 (no port) when bound port is non-default", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: "127.0.0.1" },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects bare localhost (no port)", async () => {
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/local-bootstrap",
        headers: { host: "localhost" },
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(401);
    });
  });
});

describe("POST /api/v1/auth/local-bootstrap (disabled)", () => {
  const PORT = 8000;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.FIRST_TREE_HUB_DISABLE_LOCAL_BOOTSTRAP = "1";
    app = await buildAppWithPort(PORT);
  });
  afterAll(async () => {
    delete process.env.FIRST_TREE_HUB_DISABLE_LOCAL_BOOTSTRAP;
    await app?.close();
  });

  it("returns 404 when the disable env var is set", async () => {
    await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local-bootstrap",
      headers: { host: `127.0.0.1:${PORT}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(404);
  });
});
