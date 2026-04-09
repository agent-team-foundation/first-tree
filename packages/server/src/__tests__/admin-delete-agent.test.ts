import { afterAll, describe, expect, it } from "vitest";
import { createAgent, suspendAgent } from "../services/agent.js";
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

  it("deletes a suspended agent and revokes all tokens", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    // Create agent with token, then suspend (simulating sync removing it from tree)
    const { agent, token } = await createTestAgent(app, { name: "del-agent" });
    await suspendAgent(app.db, agent.uuid);

    // Verify token no longer works (revoked by suspend)
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(401);

    // Delete suspended agent
    const delRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(delRes.statusCode).toBe(204);

    // Deleted agent is no longer visible
    const getRes = await req("GET", `/api/v1/admin/agents/${agent.uuid}`);
    expect(getRes.statusCode).toBe(404);
  });

  it("rejects deleting an active agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const agent = await createAgent(app.db, { name: "active-no-del", type: "autonomous_agent" });

    const res = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(res.statusCode).toBe(400);
  });

  it("can recreate a deleted agent via service", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    // Create, suspend, then delete
    const agent = await createAgent(app.db, {
      name: "recreate-agent",
      type: "autonomous_agent",
      displayName: "Original",
    });
    await suspendAgent(app.db, agent.uuid);
    const delRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(delRes.statusCode).toBe(204);

    // Recreate with same name (as sync would do)
    const recreated = await createAgent(app.db, {
      name: "recreate-agent",
      type: "personal_assistant",
      displayName: "Recreated",
    });
    expect(recreated.type).toBe("personal_assistant");
    expect(recreated.displayName).toBe("Recreated");
    expect(recreated.status).toBe("active");
  });

  it("deletes agent's adapter bindings", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "del-adapter-agent" });

    // Create an adapter config bound to this agent
    await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_del_test", app_secret: "secret" },
    });

    // Suspend then delete
    await suspendAgent(app.db, agent.uuid);
    const delRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(delRes.statusCode).toBe(204);

    // Adapter config should be cleaned up
    const listRes = await req("GET", "/api/v1/admin/adapters");
    const configs = listRes.json();
    const found = configs.find((c: { agentId: string }) => c.agentId === agent.uuid);
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

    const agent = await createAgent(app.db, { name: "double-del", type: "human" });
    await suspendAgent(app.db, agent.uuid);
    await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);

    const res = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(res.statusCode).toBe(404);
  });
});
