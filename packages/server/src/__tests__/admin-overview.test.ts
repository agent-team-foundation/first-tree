import { describe, expect, it } from "vitest";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("Admin Overview API", () => {
  const getApp = useTestApp();

  it("returns system overview", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { token: t1 } = await createTestAgent(app, { name: "overview-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "overview-a2" });

    // Create a chat
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.uuid] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/overview",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const overview = res.json();
    expect(overview.agents).toBeGreaterThanOrEqual(2);
    expect(overview.chats).toBeGreaterThanOrEqual(1);
    expect(typeof overview.onlineAgents).toBe("number");
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/overview" });
    expect(res.statusCode).toBe(401);
  });
});
