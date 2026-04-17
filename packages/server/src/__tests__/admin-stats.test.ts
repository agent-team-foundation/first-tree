import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { findOrCreateDirectChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createOrganization } from "../services/organization.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Admin Stats API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const ctx = await createAdminContext(app, { username: `stats-admin-${Date.now()}` });
    const req = (method: string, url: string) =>
      app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${ctx.accessToken}` },
      });
    return { req, ctx };
  }

  it("returns global stats", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const a1 = await createAgent(app.db, { name: "stats-a1", type: "human" });
    const a2 = await createAgent(app.db, {
      name: "stats-a2",
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await findOrCreateDirectChat(app.db, a1.uuid, a2.uuid);
    await sendMessage(app.db, chat.id, a1.uuid, { format: "text", content: "hello" });

    const res = await req("GET", "/api/v1/admin/stats");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAgents).toBeGreaterThanOrEqual(2);
    expect(body.totalChats).toBeGreaterThanOrEqual(1);
    expect(body.totalMessages).toBeGreaterThanOrEqual(1);
    expect(body.byOrganization).toBeInstanceOf(Array);
  });

  it("returns stats filtered by org", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const org = await createOrganization(app.db, { name: "stats-org", displayName: "Stats Org" });
    // managerId must be an existing member row — reuse the default-org admin,
    // since createAgent only requires managerId to resolve to *some* member.
    await createAgent(app.db, {
      name: "stats-org-agent",
      type: "human",
      organizationId: org.id,
      managerId: ctx.memberId,
    });

    const res = await req("GET", `/api/v1/admin/stats?org=${org.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.byOrganization).toHaveLength(1);
    expect(body.byOrganization[0].organizationId).toBe(org.id);
    expect(body.byOrganization[0].agentCount).toBe(1);
  });
});
