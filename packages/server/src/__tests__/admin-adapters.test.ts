import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestAgent, createTestApp } from "./helpers.js";

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

  it("creates and lists adapter configs (agentId required)", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-create-agent" });

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_test", app_secret: "secret" },
    });
    expect(createRes.statusCode).toBe(201);
    const config = createRes.json();
    expect(config.platform).toBe("feishu");
    expect(config.agentId).toBe(agent.uuid);
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
    const { agent } = await createTestAgent(app, { name: "adapter-get-agent" });

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "slack",
      agentId: agent.uuid,
      credentials: { bot_token: "xoxb-test" },
    });
    const created = createRes.json();

    const getRes = await req("GET", `/api/v1/admin/adapters/${created.id}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().platform).toBe("slack");
    expect(getRes.json().agentId).toBe(agent.uuid);
  });

  it("updates adapter config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-upd-agent" });

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_upd", app_secret: "secret" },
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/admin/adapters/${created.id}`, {
      status: "inactive",
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().status).toBe("inactive");
  });

  it("updates agentId to another valid agent", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent: agent1 } = await createTestAgent(app, { name: "adapter-switch-1" });
    const { agent: agent2 } = await createTestAgent(app, { name: "adapter-switch-2" });

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent1.uuid,
      credentials: { app_id: "cli_switch", app_secret: "secret" },
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/admin/adapters/${created.id}`, {
      agentId: agent2.uuid,
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().agentId).toBe(agent2.uuid);
  });

  it("deletes adapter config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-del-agent" });

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
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
      agentId: "some-agent",
      credentials: { key: "value" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing credentials", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: "some-agent",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing agentId", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "x", app_secret: "y" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("updates credentials (re-encrypts)", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-reencrypt-agent" });

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
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

  it("rejects human agent for adapter config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "human-adapter-reject", type: "human" });

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_human", app_secret: "s" },
    });
    expect(res.statusCode).toBe(400);
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

  it("enforces unique agent+platform constraint", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-unique-agent" });

    const res1 = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_u1", app_secret: "s1" },
    });
    expect(res1.statusCode).toBe(201);

    // Same agent + same platform should fail with 409
    const res2 = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_u2", app_secret: "s2" },
    });
    expect(res2.statusCode).toBe(409);
  });

  it("allows same agent on different platforms", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-cross-plat-agent" });

    const res1 = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      agentId: agent.uuid,
      credentials: { app_id: "cli_cross", app_secret: "s1" },
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await req("POST", "/api/v1/admin/adapters", {
      platform: "slack",
      agentId: agent.uuid,
      credentials: { bot_token: "xoxb-cross" },
    });
    expect(res2.statusCode).toBe(201);
  });
});
