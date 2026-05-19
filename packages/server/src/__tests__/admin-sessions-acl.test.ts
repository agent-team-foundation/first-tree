import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import * as sessionEventService from "../services/session-event.js";
import { createAdminContext, seedClient, useTestApp } from "./helpers.js";

/**
 * Verifies that /admin/sessions/agents/:agentId/:chatId{,/events} reject org
 * members who can see the agent but are NOT participants in the chat.
 *
 * Regression: before adding assertChatAccess to these routes, any member who
 * could see the agent could read tool args / error text for chats they were
 * not part of — bypassing the chat-level access control already enforced on
 * sibling listing routes.
 */
describe("Admin sessions — chat-level access control", () => {
  const getApp = useTestApp();

  async function createMember(
    app: FastifyInstance,
    adminAccessToken: string,
    organizationId: string,
    displayName: string,
  ) {
    const username = `m-${displayName}-${crypto.randomUUID().slice(0, 6)}`;
    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/members`,
      headers: { authorization: `Bearer ${adminAccessToken}` },
      payload: { username, displayName, role: "member" },
    });
    const created = createRes.json<{ id: string; password: string; agentId: string }>();
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: created.password },
    });
    const { accessToken } = loginRes.json<{ accessToken: string }>();
    // Seed a client owned by the new member's user so we can pin agents to them.
    const { members } = await import("../db/schema/members.js");
    const { eq } = await import("drizzle-orm");
    const [row] = await app.db
      .select({ userId: members.userId, organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, created.id))
      .limit(1);
    if (!row) throw new Error("member missing after creation");
    const clientId = await seedClient(app, row.userId, row.organizationId);
    return { memberId: created.id, humanAgentId: created.agentId, accessToken, clientId };
  }

  async function seedSessionRow(app: FastifyInstance, agentId: string, chatId: string) {
    await app.db.insert(agentChatSessions).values({ agentId, chatId, state: "active" }).onConflictDoNothing();
  }

  it("returns 404 to a non-participant member, 200 to a participant", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `acl-admin-${crypto.randomUUID().slice(0, 6)}` });

    // Org-visible autonomous agent the chat is "with"
    const targetAgent = await createAgent(app.db, {
      name: `acl-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "ACL target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const participant = await createMember(app, admin.accessToken, admin.organizationId, "participant");
    const outsider = await createMember(app, admin.accessToken, admin.organizationId, "outsider");

    const chat = await createChat(app.db, participant.humanAgentId, {
      type: "group",
      participantIds: [targetAgent.uuid],
    });

    await seedSessionRow(app, targetAgent.uuid, chat.id);
    await sessionEventService.appendEvent(app.db, targetAgent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "secret error text" },
    });

    const eventsAsParticipant = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${targetAgent.uuid}/sessions/${chat.id}/events`,
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(eventsAsParticipant.statusCode).toBe(200);
    expect(eventsAsParticipant.json<{ items: unknown[] }>().items).toHaveLength(1);

    const eventsAsOutsider = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${targetAgent.uuid}/sessions/${chat.id}/events`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(eventsAsOutsider.statusCode).toBe(404);

    const detailAsParticipant = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${targetAgent.uuid}/sessions/${chat.id}`,
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(detailAsParticipant.statusCode).toBe(200);

    const detailAsOutsider = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${targetAgent.uuid}/sessions/${chat.id}`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(detailAsOutsider.statusCode).toBe(404);
  });

  it("supervisor (manages a participant agent) can read events even without direct participation", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `acl-sup-${crypto.randomUUID().slice(0, 6)}` });
    const supervisor = await createMember(app, admin.accessToken, admin.organizationId, "sup");

    // Agent managed by the supervisor; supervisor's own human is NOT in the chat.
    const supervisedAgent = await createAgent(app.db, {
      name: `acl-supervised-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Supervised",
      managerId: supervisor.memberId,
      clientId: supervisor.clientId,
    });

    const otherMember = await createMember(app, admin.accessToken, admin.organizationId, "other");
    const chat = await createChat(app.db, otherMember.humanAgentId, {
      type: "group",
      participantIds: [supervisedAgent.uuid],
    });

    await seedSessionRow(app, supervisedAgent.uuid, chat.id);
    await sessionEventService.appendEvent(app.db, supervisedAgent.uuid, chat.id, {
      kind: "tool_call",
      payload: { toolUseId: "t1", name: "Bash", args: { cmd: "ls" }, status: "ok" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${supervisedAgent.uuid}/sessions/${chat.id}/events`,
      headers: { authorization: `Bearer ${supervisor.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(1);
  });
});
