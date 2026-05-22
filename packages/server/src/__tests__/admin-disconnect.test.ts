import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import * as presenceService from "../services/presence.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Admin Agent Disconnect API", () => {
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

  it("disconnects an online agent and sets presence to offline", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: `disc-a1-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Disc Agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    await presenceService.setOnline(app.db, agent.uuid, "test-instance");
    let presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.status).toBe("online");

    const res = await req("POST", `/api/v1/agents/${agent.uuid}/disconnect`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("disconnected");

    presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.status).toBe("offline");
  });

  it("returns 200 even when agent is already offline", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: `disc-a2-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const res = await req("POST", `/api/v1/agents/${agent.uuid}/disconnect`);
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected).toBe(false);
  });

  it("returns 404 for non-existent agent", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);

    const res = await req("POST", "/api/v1/agents/nonexistent/disconnect");
    expect(res.statusCode).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/any-agent/disconnect",
    });
    expect(res.statusCode).toBe(401);
  });
});
