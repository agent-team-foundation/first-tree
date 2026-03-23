import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Admin Adapters API", () => {
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

  it("creates and lists adapter configs", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_test", app_secret: "secret" },
    });
    expect(createRes.statusCode).toBe(201);
    const config = createRes.json();
    expect(config.platform).toBe("feishu");
    expect(config.hasCredentials).toBe(true);
    // Credentials must NOT be returned in the response
    expect(config.credentials).toBeUndefined();

    const listRes = await req("GET", "/api/v1/admin/adapters");
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].hasCredentials).toBe(true);
  });

  it("gets a single adapter config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "slack",
      credentials: { bot_token: "xoxb-test" },
    });
    const created = createRes.json();

    const getRes = await req("GET", `/api/v1/admin/adapters/${created.id}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().platform).toBe("slack");
  });

  it("updates adapter config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_upd", app_secret: "secret" },
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/admin/adapters/${created.id}`, {
      status: "inactive",
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().status).toBe("inactive");
  });

  it("deletes adapter config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_del", app_secret: "secret" },
    });
    const created = createRes.json();

    const delRes = await req("DELETE", `/api/v1/admin/adapters/${created.id}`);
    expect(delRes.statusCode).toBe(204);

    const getRes = await req("GET", `/api/v1/admin/adapters/${created.id}`);
    expect(getRes.statusCode).toBe(404);
  });

  it("returns 404 for non-existent adapter", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const getRes = await req("GET", "/api/v1/admin/adapters/99999");
    expect(getRes.statusCode).toBe(404);

    const patchRes = await req("PATCH", "/api/v1/admin/adapters/99999", { status: "inactive" });
    expect(patchRes.statusCode).toBe(404);

    const delRes = await req("DELETE", "/api/v1/admin/adapters/99999");
    expect(delRes.statusCode).toBe(404);
  });

  it("rejects invalid platform", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "invalid_platform",
      credentials: { key: "value" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing credentials", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
    });
    expect(res.statusCode).toBe(400);
  });

  it("updates credentials (re-encrypts)", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "old_id", app_secret: "old_secret" },
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/admin/adapters/${created.id}`, {
      credentials: { app_id: "new_id", app_secret: "new_secret" },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().hasCredentials).toBe(true);
    // Credentials still not exposed
    expect(updateRes.json().credentials).toBeUndefined();
  });

  it("defaults status to active when not provided", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "slack",
      credentials: { bot_token: "xoxb-default" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("active");
    expect(res.json().agentId).toBeNull();
  });

  it("rejects non-existent agentId", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: "does-not-exist",
      credentials: { app_id: "x", app_secret: "y" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects non-numeric adapter ID", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const getRes = await req("GET", "/api/v1/admin/adapters/abc");
    expect(getRes.statusCode).toBe(400);

    const patchRes = await req("PATCH", "/api/v1/admin/adapters/abc", { status: "inactive" });
    expect(patchRes.statusCode).toBe(400);

    const delRes = await req("DELETE", "/api/v1/admin/adapters/abc");
    expect(delRes.statusCode).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/adapters" });
    expect(res.statusCode).toBe(401);
  });
});
