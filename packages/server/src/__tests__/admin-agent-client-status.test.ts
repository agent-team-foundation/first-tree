import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { createAgent } from "../services/agent.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Admin agent client-status (Step 10)", () => {
  const getApp = useTestApp();

  async function authedReq(app: FastifyInstance) {
    const ctx = await createAdminContext(app, {
      username: `admin-cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const req = (url: string) =>
      app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${ctx.accessToken}` },
      });
    return { req, ctx };
  }

  it("reports online=false when no presence row exists", async () => {
    const app = getApp();
    const { req, ctx } = await authedReq(app);
    const agent = await createAgent(app.db, {
      name: `cs-none-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const res = await req(`/api/v1/agents/${agent.uuid}/client-status`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(false);
    // clientId now sourced from agents.clientId (pinned), not presence.
    expect(body.clientId).toBe(ctx.clientId);
  });

  it("reports online=true when agent_presence.status='online'", async () => {
    const app = getApp();
    const { req, ctx } = await authedReq(app);
    const agent = await createAgent(app.db, {
      name: `cs-on-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await app.db.insert(agentPresence).values({
      agentId: agent.uuid,
      status: "online",
      clientId: ctx.clientId,
    });
    const res = await req(`/api/v1/agents/${agent.uuid}/client-status`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(true);
  });

  it("reports offlineSince when status='offline' and last_seen_at is set", async () => {
    const app = getApp();
    const { req, ctx } = await authedReq(app);
    const agent = await createAgent(app.db, {
      name: `cs-off-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const past = new Date(Date.now() - 5 * 60 * 1000);
    await app.db.insert(agentPresence).values({
      agentId: agent.uuid,
      status: "offline",
      clientId: null,
      lastSeenAt: past,
    });
    const res = await req(`/api/v1/agents/${agent.uuid}/client-status`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(false);
    expect(body.offlineSince).toBe(past.toISOString());
  });
});
