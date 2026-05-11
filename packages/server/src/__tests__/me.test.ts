import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

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

  it("rejects unauthenticated request", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
    });
    expect(res.statusCode).toBe(401);
  });
});
