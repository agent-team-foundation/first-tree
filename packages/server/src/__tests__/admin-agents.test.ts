import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Admin Agents API", () => {
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

  it("creates and retrieves an agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/admin/agents", {
      id: "agent-1",
      type: "autonomous_agent",
      displayName: "Bot One",
    });
    expect(createRes.statusCode).toBe(201);
    const agent = createRes.json();
    expect(agent.id).toBe("agent-1");
    expect(agent.inboxId).toBe("inbox_agent-1");

    const getRes = await req("GET", "/admin/agents/agent-1");
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe("agent-1");
  });

  it("lists agents with pagination", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    await req("POST", "/admin/agents", { id: "a1", type: "human" });
    await req("POST", "/admin/agents", { id: "a2", type: "human" });

    const res = await req("GET", "/admin/agents?limit=1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeDefined();
  });

  it("updates an agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    await req("POST", "/admin/agents", { id: "upd-1", type: "human" });

    const res = await req("PATCH", "/admin/agents/upd-1", {
      displayName: "Updated",
      status: "suspended",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Updated");
    expect(res.json().status).toBe("suspended");
  });

  it("rejects unauthenticated requests", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/admin/agents" });
    expect(res.statusCode).toBe(401);
  });

  describe("Token management", () => {
    it("creates, lists, and revokes tokens", async () => {
      const app = await appPromise;
      const req = await authedRequest(app);
      await req("POST", "/admin/agents", { id: "tok-agent", type: "autonomous_agent" });

      // Create token
      const createRes = await req("POST", "/admin/agents/tok-agent/tokens", { name: "dev" });
      expect(createRes.statusCode).toBe(201);
      const tokenBody = createRes.json();
      expect(tokenBody.token).toMatch(/^aghub_/);
      expect(tokenBody.name).toBe("dev");

      // List tokens
      const listRes = await req("GET", "/admin/agents/tok-agent/tokens");
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(1);

      // Revoke token
      const revokeRes = await req("DELETE", `/admin/agents/tok-agent/tokens/${tokenBody.id}`);
      expect(revokeRes.statusCode).toBe(204);
    });
  });
});
