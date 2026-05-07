import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Admin Auth", () => {
  const getApp = useTestApp();

  describe("POST /api/v1/auth/login", () => {
    it("returns tokens on valid credentials", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      expect(admin.accessToken).toBeDefined();
      expect(admin.refreshToken).toBeDefined();
    });

    it("rejects invalid password", async () => {
      const app = getApp();
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects non-existent user", async () => {
      const app = getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "nobody", password: "whatever" },
      });
      expect(res.statusCode).toBe(401);
    });

    // Regression: services/auth.ts::login picks the most-recently-joined active
    // membership as the JWT default org. Without `ORDER BY created_at DESC, id
    // DESC` the multi-org user gets a non-deterministic default each login,
    // and `POST /admin/agents` falls back to that default when the body omits
    // `organizationId` — which silently lands new agents in the wrong tenant.
    it("picks the most-recently-joined active membership as the JWT default org", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);

      const create = await app.inject({
        method: "POST",
        url: "/api/v1/me/organizations",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {
          name: `t-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Second Org",
        },
      });
      expect(create.statusCode).toBe(201);
      const secondOrgId = create.json<{ organization: { id: string } }>().organization.id;
      expect(secondOrgId).not.toBe(admin.organizationId);

      // Password login → JWT default member should be the most recent join (second org).
      const re = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: admin.username, password: admin.password },
      });
      expect(re.statusCode).toBe(200);
      const tokens = re.json<{ accessToken: string }>();

      const me = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ member: { organizationId: string } }>().member.organizationId).toBe(secondOrgId);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("returns a fresh access+refresh pair (sliding window)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: admin.refreshToken },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy();
      // Sliding window: rotated refresh token must differ from the one we sent.
      expect(body.refreshToken).not.toBe(admin.refreshToken);
    });

    it("rejects invalid refresh token", async () => {
      const app = getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: "invalid" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("the rotated refresh token can itself be used to refresh again", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: admin.refreshToken },
      });
      expect(first.statusCode).toBe(200);
      const next = first.json<{ refreshToken: string }>().refreshToken;
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: next },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toHaveProperty("accessToken");
    });
  });
});
