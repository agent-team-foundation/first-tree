import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent, suspendAgent } from "../services/agent.js";
import { createAdminContext, createTestAgent, useTestApp } from "./helpers.js";

describe("Admin DELETE Agent API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const ctx = await createAdminContext(app);
    const req = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        ...(payload ? { payload } : {}),
      });
    return { req, ctx };
  }

  it("deletes a suspended agent", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const { agent } = await createTestAgent(app, { name: "del-agent" });
    await suspendAgent(app.db, agent.uuid);

    const delRes = await req("DELETE", `/api/v1/agents/${agent.uuid}`);
    expect(delRes.statusCode).toBe(204);

    const getRes = await req("GET", `/api/v1/agents/${agent.uuid}`);
    expect(getRes.statusCode).toBe(404);
  });

  it("rejects deleting an active agent", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: "active-no-del",
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const res = await req("DELETE", `/api/v1/agents/${agent.uuid}`);
    expect(res.statusCode).toBe(400);
  });

  it("can recreate a deleted agent via service", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: "recreate-agent",
      type: "agent",
      displayName: "Original",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await suspendAgent(app.db, agent.uuid);
    const delRes = await req("DELETE", `/api/v1/agents/${agent.uuid}`);
    expect(delRes.statusCode).toBe(204);

    const recreated = await createAgent(app.db, {
      name: "recreate-agent",
      type: "agent",
      displayName: "Recreated",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    expect(recreated.type).toBe("agent");
    expect(recreated.displayName).toBe("Recreated");
    expect(recreated.status).toBe("active");
  });

  it("returns 404 for non-existent agent", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const res = await req("DELETE", "/api/v1/admin/agents/non-existent");
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for already deleted agent", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: "double-del",
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await suspendAgent(app.db, agent.uuid);
    await req("DELETE", `/api/v1/agents/${agent.uuid}`);

    const res = await req("DELETE", `/api/v1/agents/${agent.uuid}`);
    expect(res.statusCode).toBe(404);
  });
});
