import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestApp } from "./helpers.js";

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

  it("deletes (suspends) an agent and revokes all tokens", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    // Create agent with token
    await req("POST", "/admin/agents", { id: "del-agent", type: "autonomous_agent" });
    const tokenRes = await req("POST", "/admin/agents/del-agent/tokens", { name: "test" });
    expect(tokenRes.statusCode).toBe(201);
    const token = tokenRes.json().token;

    // Verify agent works
    const meRes = await app.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);

    // Delete agent
    const delRes = await req("DELETE", "/admin/agents/del-agent");
    expect(delRes.statusCode).toBe(204);

    // Verify agent is suspended
    const getRes = await req("GET", "/admin/agents/del-agent");
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().status).toBe("suspended");

    // Token should no longer work
    const meRes2 = await app.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes2.statusCode).toBe(401);
  });

  it("returns 404 for non-existent agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("DELETE", "/admin/agents/non-existent");
    expect(res.statusCode).toBe(404);
  });
});
