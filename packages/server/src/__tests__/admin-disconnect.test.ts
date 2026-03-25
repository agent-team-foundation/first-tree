import { afterAll, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import * as presenceService from "../services/presence.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Admin Agent Disconnect API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  async function authedRequest(app: Awaited<ReturnType<typeof createTestApp>>) {
    const admin = await createTestAdmin(app);
    return (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
  }

  it("disconnects an online agent and sets presence to offline", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const agent = await createAgent(app.db, {
      id: `disc-a1-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Disc Agent",
    });

    // Simulate agent being online
    await presenceService.setOnline(app.db, agent.id, "test-instance");
    let presence = await presenceService.getPresence(app.db, agent.id);
    expect(presence?.status).toBe("online");

    // Call disconnect endpoint
    const res = await req("POST", `/api/v1/admin/agents/${agent.id}/disconnect`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // No actual WS connection in test, so wasConnected is false (forceDisconnect returns false)
    expect(body).toHaveProperty("disconnected");

    // Presence should now be offline
    presence = await presenceService.getPresence(app.db, agent.id);
    expect(presence?.status).toBe("offline");
  });

  it("returns 200 even when agent is already offline", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const agent = await createAgent(app.db, {
      id: `disc-a2-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });

    const res = await req("POST", `/api/v1/admin/agents/${agent.id}/disconnect`);
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected).toBe(false);
  });

  it("returns 404 for non-existent agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/agents/nonexistent/disconnect");
    expect(res.statusCode).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const app = await appPromise;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/agents/any-agent/disconnect",
    });
    expect(res.statusCode).toBe(401);
  });
});
