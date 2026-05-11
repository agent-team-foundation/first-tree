import { describe, expect, it } from "vitest";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("Admin Overview API", () => {
  const getApp = useTestApp();

  it("returns system overview", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const a1 = await createTestAgent(app, { name: "overview-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "overview-a2" });

    // Create a chat via the agent-scoped API (uses X-Agent-Id + JWT).
    await a1.request("POST", "/api/v1/agent/chats", { type: "direct", participantIds: [a2.uuid] });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/overview`,
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
    const res = await app.inject({ method: "GET", url: "/api/v1/orgs/any/overview" });
    expect(res.statusCode).toBe(401);
  });
});
