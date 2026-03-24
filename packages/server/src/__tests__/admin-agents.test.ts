import { afterAll, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
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

  it("retrieves an agent created via service", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await createAgent(app.db, { id: "agent-1", type: "autonomous_agent", displayName: "Bot One" });

    const getRes = await req("GET", "/api/v1/admin/agents/agent-1");
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe("agent-1");
    expect(getRes.json().inboxId).toBe("inbox_agent-1");
  });

  it("lists agents with pagination", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    await createAgent(app.db, { id: "a1", type: "human" });
    await createAgent(app.db, { id: "a2", type: "human" });

    const res = await req("GET", "/api/v1/admin/agents?limit=1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeDefined();
  });

  it("lists agents with presenceStatus field", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    await createAgent(app.db, { id: "presence-test", type: "autonomous_agent" });

    const res = await req("GET", "/api/v1/admin/agents?limit=50");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const agent = body.items.find((a: { id: string }) => a.id === "presence-test");
    expect(agent).toBeDefined();
    // No presence record → defaults to "offline"
    expect(agent.presenceStatus).toBe("offline");
  });

  it("rejects unauthenticated requests", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/agents" });
    expect(res.statusCode).toBe(401);
  });

  describe("Token management", () => {
    it("creates, lists, and revokes tokens", async () => {
      const app = await appPromise;
      const req = await authedRequest(app);
      await createAgent(app.db, { id: "tok-agent", type: "autonomous_agent" });

      // Create token
      const createRes = await req("POST", "/api/v1/admin/agents/tok-agent/tokens", { name: "dev" });
      expect(createRes.statusCode).toBe(201);
      const tokenBody = createRes.json();
      expect(tokenBody.token).toMatch(/^aghub_/);
      expect(tokenBody.name).toBe("dev");

      // List tokens
      const listRes = await req("GET", "/api/v1/admin/agents/tok-agent/tokens");
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(1);

      // Revoke token
      const revokeRes = await req("DELETE", `/api/v1/admin/agents/tok-agent/tokens/${tokenBody.id}`);
      expect(revokeRes.statusCode).toBe(204);
    });
  });
});
