import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Admin Organizations API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const ctx = await createAdminContext(app, { username: `org-admin-${Date.now()}` });
    const req = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        ...(payload ? { payload } : {}),
      });
    return { req, ctx };
  }

  it("lists organizations (default org exists)", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const res = await req("GET", "/api/v1/admin/organizations");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string; name: string }> }>();
    expect(body.items.some((o) => o.name === "default")).toBe(true);
  });

  it("creates a new organization", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/organizations", {
      name: "test-org",
      displayName: "Test Organization",
      maxAgents: 10,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // id should be a UUID, not the name
    expect(body.id).toMatch(/^[0-9a-f]{8}-/);
    expect(body.name).toBe("test-org");
    expect(body.displayName).toBe("Test Organization");
    expect(body.maxAgents).toBe(10);
    expect(body.maxMessagesPerMinute).toBe(0);
  });

  it("rejects duplicate organization name", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      name: "dup-org",
      displayName: "First",
    });
    const res = await req("POST", "/api/v1/admin/organizations", {
      name: "dup-org",
      displayName: "Second",
    });
    expect(res.statusCode).toBe(409);
  });

  it("gets organization by name", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      name: "get-org",
      displayName: "Get Me",
    });

    const res = await req("GET", "/api/v1/admin/organizations/get-org");
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Get Me");
  });

  it("gets organization by UUID", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/organizations", {
      name: "get-uuid-org",
      displayName: "Get By UUID",
    });
    const created = createRes.json<{ id: string }>();

    const res = await req("GET", `/api/v1/admin/organizations/${created.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Get By UUID");
  });

  it("returns 404 for non-existent organization", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const res = await req("GET", "/api/v1/admin/organizations/no-such-org");
    expect(res.statusCode).toBe(404);
  });

  it("updates an organization", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/organizations", {
      name: "update-org",
      displayName: "Old Name",
    });
    const created = createRes.json<{ id: string }>();

    const res = await req("PATCH", `/api/v1/admin/organizations/${created.id}`, {
      displayName: "New Name",
      maxAgents: 50,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("New Name");
    expect(res.json().maxAgents).toBe(50);
  });

  it("updates an organization by name", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      name: "patch-by-name",
      displayName: "Patch Me",
    });

    const res = await req("PATCH", "/api/v1/admin/organizations/patch-by-name", {
      displayName: "Patched",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Patched");
  });

  it("deletes an empty organization", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/organizations", {
      name: "delete-org",
      displayName: "To Delete",
    });
    const created = createRes.json<{ id: string }>();

    const res = await req("DELETE", `/api/v1/admin/organizations/${created.id}`);
    expect(res.statusCode).toBe(204);

    const getRes = await req("GET", `/api/v1/admin/organizations/${created.id}`);
    expect(getRes.statusCode).toBe(404);
  });

  it("deletes an organization by name", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    await req("POST", "/api/v1/admin/organizations", {
      name: "delete-by-name",
      displayName: "Delete By Name",
    });

    const res = await req("DELETE", "/api/v1/admin/organizations/delete-by-name");
    expect(res.statusCode).toBe(204);
  });

  it("cannot delete organization with active agents", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/organizations", {
      name: "busy-org",
      displayName: "Busy Org",
    });
    const created = createRes.json<{ id: string }>();

    // human type skips the clientId requirement — enough to prove the org has
    // an active agent that should block deletion.
    await createAgent(app.db, {
      name: "org-agent",
      type: "human",
      organizationId: created.id,
      managerId: ctx.memberId,
    });

    const res = await req("DELETE", `/api/v1/admin/organizations/${created.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/active agents/i);
  });

  it("cannot delete the default organization", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const res = await req("DELETE", "/api/v1/admin/organizations/default");
    expect(res.statusCode).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/organizations" });
    expect(res.statusCode).toBe(401);
  });
});
