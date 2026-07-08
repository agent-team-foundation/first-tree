import { describe, expect, it } from "vitest";
import { users } from "../db/schema/users.js";
import { signTokensForUser } from "../services/auth.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";

describe("GET /api/v1/me", () => {
  const getApp = useTestApp();

  it("returns current user + memberships + default org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      user: { id: string; username: string; displayName: string };
      memberships: Array<{ id: string; organizationId: string; role: string; agentId: string }>;
      defaultOrganizationId: string | null;
    }>();

    expect(body.user).toBeDefined();
    expect(body.user.username).toBe(admin.username);
    expect(body.memberships.length).toBeGreaterThanOrEqual(1);
    expect(body.memberships[0]?.role).toBe("admin");
    expect(body.memberships[0]?.agentId).toBeDefined();
    expect(body.defaultOrganizationId).toBe(body.memberships[0]?.organizationId);
  });

  it("returns an empty membership list and null default org for users without memberships", async () => {
    const app = getApp();
    const userId = uuidv7();
    await app.db.insert(users).values({
      id: userId,
      username: `me-no-membership-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "test",
      displayName: "No Membership",
    });
    const tokens = await signTokensForUser(TEST_JWT_SECRET, userId, {
      accessTokenExpiry: "30m",
      refreshTokenExpiry: "30d",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { id: userId },
      defaultOrganizationId: null,
      memberships: [],
    });
  });

  it("rejects unauthenticated request", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
    });
    expect(res.statusCode).toBe(401);
  });
});
