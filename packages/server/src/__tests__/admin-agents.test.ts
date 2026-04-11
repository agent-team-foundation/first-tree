import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Admin Agents API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const admin = await createTestAdmin(app);
    return (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
  }

  it("rejects creating an agent with a reserved `__` name prefix", async () => {
    const app = getApp();
    await expect(createAgent(app.db, { name: "__hub_system_tasks", type: "autonomous_agent" })).rejects.toThrow(
      /reserved/i,
    );
  });

  it("retrieves an agent created via service", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const agent = await createAgent(app.db, { name: "agent-1", type: "autonomous_agent", displayName: "Bot One" });

    const getRes = await req("GET", `/api/v1/admin/agents/${agent.uuid}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().uuid).toBe(agent.uuid);
    expect(getRes.json().inboxId).toBe(`inbox_${agent.uuid}`);
  });

  it("lists agents with pagination", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    await createAgent(app.db, { name: "a1", type: "human" });
    await createAgent(app.db, { name: "a2", type: "human" });

    const res = await req("GET", "/api/v1/admin/agents?limit=1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeDefined();
  });

  it("lists agents with presenceStatus field", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const created = await createAgent(app.db, { name: "presence-test", type: "autonomous_agent" });

    const res = await req("GET", "/api/v1/admin/agents?limit=50");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const agent = body.items.find((a: { uuid: string }) => a.uuid === created.uuid);
    expect(agent).toBeDefined();
    // No presence record → defaults to "offline"
    expect(agent.presenceStatus).toBe("offline");
  });

  it("creates an agent via POST", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/agents", {
      name: "api-created",
      type: "autonomous_agent",
      displayName: "API Bot",
      profile: "I am a test bot.",
      metadata: { role: "testing" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("api-created");
    expect(body.displayName).toBe("API Bot");
    expect(body.profile).toBe("I am a test bot.");
    expect(body.metadata.role).toBe("testing");
  });

  it("updates an agent via PATCH", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await createAgent(app.db, { name: "patch-target", type: "human", displayName: "Old Name" });

    const res = await req("PATCH", `/api/v1/admin/agents/${agent.uuid}`, {
      displayName: "New Name",
      profile: "Updated profile.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("New Name");
    expect(res.json().profile).toBe("Updated profile.");
  });

  it("suspends and reactivates an agent", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await createAgent(app.db, { name: "lifecycle-agent", type: "autonomous_agent" });

    // Suspend
    const suspendRes = await req("POST", `/api/v1/admin/agents/${agent.uuid}/suspend`);
    expect(suspendRes.statusCode).toBe(200);
    expect(suspendRes.json().status).toBe("suspended");

    // Reactivate
    const reactivateRes = await req("POST", `/api/v1/admin/agents/${agent.uuid}/reactivate`);
    expect(reactivateRes.statusCode).toBe(200);
    expect(reactivateRes.json().status).toBe("active");
  });

  it("deletes only suspended agents", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await createAgent(app.db, { name: "delete-test", type: "autonomous_agent" });

    // Cannot delete active agent
    const failRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(failRes.statusCode).toBe(400);

    // Suspend first, then delete
    await req("POST", `/api/v1/admin/agents/${agent.uuid}/suspend`);
    const okRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(okRes.statusCode).toBe(204);
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/agents" });
    expect(res.statusCode).toBe(401);
  });

  describe("Token management", () => {
    it("creates, lists, and revokes tokens", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const agent = await createAgent(app.db, { name: "tok-agent", type: "autonomous_agent" });

      // Create token
      const createRes = await req("POST", `/api/v1/admin/agents/${agent.uuid}/tokens`, { name: "dev" });
      expect(createRes.statusCode).toBe(201);
      const tokenBody = createRes.json();
      expect(tokenBody.token).toMatch(/^aghub_/);
      expect(tokenBody.name).toBe("dev");

      // List tokens
      const listRes = await req("GET", `/api/v1/admin/agents/${agent.uuid}/tokens`);
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(1);

      // Revoke token
      const revokeRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}/tokens/${tokenBody.id}`);
      expect(revokeRes.statusCode).toBe(204);
    });
  });
});
