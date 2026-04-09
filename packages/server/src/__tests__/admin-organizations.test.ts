import { afterAll, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Admin Organizations API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  async function authedRequest(app: Awaited<ReturnType<typeof createTestApp>>) {
    const admin = await createTestAdmin(app, { username: `org-admin-${Date.now()}` });
    return (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
  }

  it("lists organizations (default org exists)", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("GET", "/api/v1/admin/organizations");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string }> }>();
    expect(body.items.some((o) => o.id === "default")).toBe(true);
  });

  it("creates a new organization", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/organizations", {
      id: "test-org",
      displayName: "Test Organization",
      maxAgents: 10,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe("test-org");
    expect(body.displayName).toBe("Test Organization");
    expect(body.maxAgents).toBe(10);
    expect(body.maxMessagesPerMinute).toBe(0);
  });

  it("rejects duplicate organization id", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      id: "dup-org",
      displayName: "First",
    });
    const res = await req("POST", "/api/v1/admin/organizations", {
      id: "dup-org",
      displayName: "Second",
    });
    expect(res.statusCode).toBe(409);
  });

  it("gets organization by id", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      id: "get-org",
      displayName: "Get Me",
    });

    const res = await req("GET", "/api/v1/admin/organizations/get-org");
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Get Me");
  });

  it("returns 404 for non-existent organization", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("GET", "/api/v1/admin/organizations/no-such-org");
    expect(res.statusCode).toBe(404);
  });

  it("updates an organization", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      id: "update-org",
      displayName: "Old Name",
    });

    const res = await req("PATCH", "/api/v1/admin/organizations/update-org", {
      displayName: "New Name",
      maxAgents: 50,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("New Name");
    expect(res.json().maxAgents).toBe(50);
  });

  it("deletes an empty organization", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      id: "delete-org",
      displayName: "To Delete",
    });

    const res = await req("DELETE", "/api/v1/admin/organizations/delete-org");
    expect(res.statusCode).toBe(204);

    const getRes = await req("GET", "/api/v1/admin/organizations/delete-org");
    expect(getRes.statusCode).toBe(404);
  });

  it("cannot delete organization with active agents", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      id: "busy-org",
      displayName: "Busy Org",
    });
    await createAgent(app.db, {
      name: "org-agent",
      type: "autonomous_agent",
      organizationId: "busy-org",
    });

    const res = await req("DELETE", "/api/v1/admin/organizations/busy-org");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/active agents/i);
  });

  it("cannot delete the default organization", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("DELETE", "/api/v1/admin/organizations/default");
    expect(res.statusCode).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/organizations" });
    expect(res.statusCode).toBe(401);
  });
});
