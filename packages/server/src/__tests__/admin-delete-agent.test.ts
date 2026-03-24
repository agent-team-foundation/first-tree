import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestAgent, createTestApp } from "./helpers.js";

describe("Admin DELETE Agent API", () => {
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

  it("soft-deletes an agent and revokes all tokens", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    // Create agent with token
    await req("POST", "/api/v1/admin/agents", { id: "del-agent", type: "autonomous_agent" });
    const tokenRes = await req("POST", "/api/v1/admin/agents/del-agent/tokens", { name: "test" });
    expect(tokenRes.statusCode).toBe(201);
    const token = tokenRes.json().token;

    // Verify agent works
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);

    // Delete agent
    const delRes = await req("DELETE", "/api/v1/admin/agents/del-agent");
    expect(delRes.statusCode).toBe(204);

    // Deleted agent is no longer visible via GET
    const getRes = await req("GET", "/api/v1/admin/agents/del-agent");
    expect(getRes.statusCode).toBe(404);

    // Deleted agent is not in list
    const listRes = await req("GET", "/api/v1/admin/agents");
    const agents = listRes.json().items;
    const found = agents.find((a: { id: string }) => a.id === "del-agent");
    expect(found).toBeUndefined();

    // Token should no longer work
    const meRes2 = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes2.statusCode).toBe(401);
  });

  it("can recreate a deleted agent with the same ID", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    // Create and delete
    await req("POST", "/api/v1/admin/agents", {
      id: "recreate-agent",
      type: "autonomous_agent",
      displayName: "Original",
    });
    const delRes = await req("DELETE", "/api/v1/admin/agents/recreate-agent");
    expect(delRes.statusCode).toBe(204);

    // Recreate with same ID but different data
    const createRes = await req("POST", "/api/v1/admin/agents", {
      id: "recreate-agent",
      type: "personal_assistant",
      displayName: "Recreated",
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().type).toBe("personal_assistant");
    expect(createRes.json().displayName).toBe("Recreated");
    expect(createRes.json().status).toBe("active");
  });

  it("cannot recreate an active agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/agents", { id: "active-agent", type: "autonomous_agent" });

    const createRes = await req("POST", "/api/v1/admin/agents", { id: "active-agent", type: "human" });
    expect(createRes.statusCode).toBe(409);
  });

  it("deletes agent's adapter bindings", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { id: "del-adapter-agent" });

    // Create an adapter config bound to this agent
    await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.id,
      credentials: { app_id: "cli_del_test", app_secret: "secret" },
    });

    // Delete agent
    const delRes = await req("DELETE", `/api/v1/admin/agents/${agent.id}`);
    expect(delRes.statusCode).toBe(204);

    // Adapter config should be cleaned up
    const listRes = await req("GET", "/api/v1/admin/adapters");
    const configs = listRes.json();
    const found = configs.find((c: { agentId: string }) => c.agentId === agent.id);
    expect(found).toBeUndefined();
  });

  it("returns 404 for non-existent agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("DELETE", "/api/v1/admin/agents/non-existent");
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for already deleted agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/agents", { id: "double-del", type: "human" });
    await req("DELETE", "/api/v1/admin/agents/double-del");

    const res = await req("DELETE", "/api/v1/admin/agents/double-del");
    expect(res.statusCode).toBe(404);
  });
});
