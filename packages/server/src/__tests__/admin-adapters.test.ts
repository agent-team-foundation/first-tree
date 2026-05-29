import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

const KAEL_CREDS = { kaelUserId: "user_test", kaelProjectId: "proj_test" };

describe("Admin Adapters API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const admin = await createTestAdmin(app);
    const req = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
    return Object.assign(req, { admin });
  }

  it("creates and lists adapter configs (agentId required)", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-create-agent" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: KAEL_CREDS,
    });
    expect(createRes.statusCode).toBe(201);
    const config = createRes.json();
    expect(config.platform).toBe("kael");
    expect(config.agentId).toBe(agent.uuid);
    expect(config.hasCredentials).toBe(true);
    // Credentials must NOT be returned in the response
    expect(config.credentials).toBeUndefined();

    const listRes = await req("GET", `/api/v1/orgs/${req.admin.organizationId}/adapters`);
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].hasCredentials).toBe(true);
  });

  it("gets a single adapter config", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-get-agent" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: KAEL_CREDS,
    });
    const created = createRes.json();

    const getRes = await req("GET", `/api/v1/adapters/${created.id}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().platform).toBe("kael");
    expect(getRes.json().agentId).toBe(agent.uuid);
  });

  it("updates adapter config", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-upd-agent" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: KAEL_CREDS,
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/adapters/${created.id}`, {
      status: "inactive",
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().status).toBe("inactive");
  });

  it("updates agentId to another valid agent", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent: agent1 } = await createTestAgent(app, { name: "adapter-switch-1" });
    const { agent: agent2 } = await createTestAgent(app, { name: "adapter-switch-2" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent1.uuid,
      credentials: KAEL_CREDS,
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/adapters/${created.id}`, {
      agentId: agent2.uuid,
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().agentId).toBe(agent2.uuid);
  });

  it("deletes adapter config", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-del-agent" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: KAEL_CREDS,
    });
    const created = createRes.json();

    const delRes = await req("DELETE", `/api/v1/adapters/${created.id}`);
    expect(delRes.statusCode).toBe(204);

    const getRes = await req("GET", `/api/v1/adapters/${created.id}`);
    expect(getRes.statusCode).toBe(404);
  });

  it("returns 404 for non-existent adapter", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const getRes = await req("GET", "/api/v1/adapters/99999");
    expect(getRes.statusCode).toBe(404);

    const patchRes = await req("PATCH", "/api/v1/adapters/99999", { status: "inactive" });
    expect(patchRes.statusCode).toBe(404);

    const delRes = await req("DELETE", "/api/v1/adapters/99999");
    expect(delRes.statusCode).toBe(404);
  });

  it("rejects invalid platform", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const res = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "invalid_platform",
      agentId: "some-agent",
      credentials: { key: "value" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing credentials", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const res = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: "some-agent",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing agentId", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const res = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      credentials: KAEL_CREDS,
    });
    expect(res.statusCode).toBe(400);
  });

  it("updates credentials (re-encrypts)", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-reencrypt-agent" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: { kaelUserId: "user_old", kaelProjectId: "proj_old" },
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/adapters/${created.id}`, {
      credentials: { kaelUserId: "user_new", kaelProjectId: "proj_new" },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().hasCredentials).toBe(true);
    // Credentials still not exposed
    expect(updateRes.json().credentials).toBeUndefined();
  });

  it("rejects non-existent agentId", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const res = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: "does-not-exist",
      credentials: KAEL_CREDS,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects human agent for adapter config", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "human-adapter-reject", type: "human" });

    const res = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: KAEL_CREDS,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-numeric adapter ID", async () => {
    const app = getApp();
    const req = await authedRequest(app);

    const getRes = await req("GET", "/api/v1/adapters/abc");
    expect(getRes.statusCode).toBe(400);

    const patchRes = await req("PATCH", "/api/v1/adapters/abc", { status: "inactive" });
    expect(patchRes.statusCode).toBe(400);

    const delRes = await req("DELETE", "/api/v1/adapters/abc");
    expect(delRes.statusCode).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/orgs/any/adapters" });
    expect(res.statusCode).toBe(401);
  });

  it("enforces unique agent+platform constraint", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent } = await createTestAgent(app, { name: "adapter-unique-agent" });

    const res1 = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: { kaelUserId: "user_u1", kaelProjectId: "proj_u1" },
    });
    expect(res1.statusCode).toBe(201);

    // Same agent + same platform should fail with 409
    const res2 = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/adapters`, {
      platform: "kael",
      agentId: agent.uuid,
      credentials: { kaelUserId: "user_u2", kaelProjectId: "proj_u2" },
    });
    expect(res2.statusCode).toBe(409);
  });
});
