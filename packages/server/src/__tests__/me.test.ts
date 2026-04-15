import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("GET /api/v1/me", () => {
  const getApp = useTestApp();

  it("returns current user, member, and agent info", async () => {
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
      member: { id: string; organizationId: string; role: string; agentId: string };
      agent: { uuid: string; name: string; inboxId: string };
    }>();

    expect(body.user).toBeDefined();
    expect(body.user.username).toBe(admin.username);
    expect(body.member).toBeDefined();
    expect(body.member.role).toBe("admin");
    expect(body.member.agentId).toBeDefined();
    expect(body.agent).toBeDefined();
    expect(body.agent.uuid).toBe(body.member.agentId);
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
