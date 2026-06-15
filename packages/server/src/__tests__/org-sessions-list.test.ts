import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { createAdminContext, seedClient, useTestApp } from "./helpers.js";

/**
 * Filter integrity for `GET /orgs/:orgId/sessions` (listAllSessions).
 *
 * Visibility policy: org session rows are chat-access aware. Ordinary members
 * see only sessions in chats they can open. Admins can keep the org-wide
 * operational row list, but chat self-description and first-message summary
 * are masked unless the admin also has chat access. These tests also pin:
 *
 *   - the organization boundary cannot be crossed (neither via the URL's
 *     :orgId nor via rows leaking into another org's listing);
 *   - `agentId` and `state` narrow the result set;
 *   - evicted sessions stay hidden unless explicitly requested;
 *   - cursor pagination advances without overlap, and a malformed cursor
 *     is a 400, not a Postgres error surfaced as a 500.
 */
describe("GET /orgs/:orgId/sessions — filter integrity", () => {
  const getApp = useTestApp();

  type SessionItem = { agentId: string; chatId: string; state: string; topic: string | null; summary: string | null };
  type ListResponse = { items: SessionItem[]; nextCursor: string | null };

  async function seedChat(app: FastifyInstance, organizationId: string, topic?: string): Promise<string> {
    const id = `chat-${randomUUID().slice(0, 8)}`;
    await app.db.insert(chats).values({ id, organizationId, type: "group", topic });
    return id;
  }

  async function seedSession(
    app: FastifyInstance,
    agentId: string,
    chatId: string,
    opts: { state?: string; updatedAt?: Date } = {},
  ): Promise<void> {
    await app.db.insert(agentChatSessions).values({
      agentId,
      chatId,
      state: opts.state ?? "active",
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    });
  }

  async function seedSpeaker(app: FastifyInstance, chatId: string, agentId: string): Promise<void> {
    await app.db
      .insert(chatMembership)
      .values({ chatId, agentId, role: "member", accessMode: "speaker" })
      .onConflictDoNothing();
  }

  async function seedFirstMessage(app: FastifyInstance, chatId: string, senderId: string, text: string): Promise<void> {
    await app.db.insert(messages).values({
      id: `msg-${randomUUID().slice(0, 8)}`,
      chatId,
      senderId,
      format: "text",
      content: { text },
      source: "api",
    });
  }

  async function createMember(app: FastifyInstance, admin: Awaited<ReturnType<typeof createAdminContext>>) {
    const username = `member-${randomUUID().slice(0, 8)}`;
    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/members`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { username, displayName: "Session Member", role: "member" },
    });
    const created = createRes.json<{ id: string; password: string; agentId: string }>();
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: created.password },
    });
    const { accessToken } = loginRes.json<{ accessToken: string }>();
    const [member] = await app.db
      .select({ userId: members.userId, organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, created.id))
      .limit(1);
    if (!member) throw new Error("member missing after creation");
    const clientId = await seedClient(app, member.userId, member.organizationId);
    return { memberId: created.id, humanAgentId: created.agentId, accessToken, clientId };
  }

  async function listSessions(
    app: FastifyInstance,
    accessToken: string,
    orgId: string,
    query = "",
  ): Promise<{ statusCode: number; body: ListResponse }> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/sessions${query}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return { statusCode: res.statusCode, body: res.json<ListResponse>() };
  }

  it("never returns another organization's sessions, and rejects a foreign :orgId with 403", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    // Foreign org with its own agent + chat + active session, seeded directly.
    const foreignOrgId = `org-${randomUUID().slice(0, 6)}`;
    await app.db.insert(organizations).values({
      id: foreignOrgId,
      name: foreignOrgId.slice(0, 30),
      displayName: "Foreign Org",
    });
    const foreignAgentUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: foreignAgentUuid,
      name: `foreign-${randomUUID().slice(0, 6)}`,
      organizationId: foreignOrgId,
      type: "agent",
      displayName: "Foreign Agent",
      inboxId: `inbox_${foreignAgentUuid}`,
      managerId: admin.memberId,
    });
    const foreignChatId = await seedChat(app, foreignOrgId, "foreign topic");
    await seedSession(app, foreignAgentUuid, foreignChatId);

    // Own-org session for contrast.
    const ownAgent = await createAgent(app.db, {
      name: `own-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Own Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const ownChatId = await seedChat(app, admin.organizationId, "own topic");
    await seedSpeaker(app, ownChatId, ownAgent.uuid);
    await seedSession(app, ownAgent.uuid, ownChatId);

    const own = await listSessions(app, admin.accessToken, admin.organizationId, "?limit=100");
    expect(own.statusCode).toBe(200);
    expect(own.body.items.some((i) => i.chatId === ownChatId)).toBe(true);
    expect(own.body.items.some((i) => i.chatId === foreignChatId)).toBe(false);
    expect(own.body.items.find((i) => i.chatId === ownChatId)?.topic).toBe("own topic");

    const foreign = await listSessions(app, admin.accessToken, foreignOrgId);
    expect(foreign.statusCode).toBe(403);
  });

  it("ordinary members see participant and managed-agent sessions, but not outsider chat topics or summaries", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const viewer = await createMember(app, admin);
    const otherMember = await createMember(app, admin);

    const participantAgent = await createAgent(app.db, {
      name: `part-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Participant Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const managedAgent = await createAgent(app.db, {
      name: `mgr-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Managed Agent",
      managerId: viewer.memberId,
      clientId: viewer.clientId,
    });
    const hiddenAgent = await createAgent(app.db, {
      name: `hidden-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Hidden Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const participantChatId = await seedChat(app, admin.organizationId, "participant topic");
    await seedSpeaker(app, participantChatId, viewer.humanAgentId);
    await seedSpeaker(app, participantChatId, participantAgent.uuid);
    await seedFirstMessage(app, participantChatId, viewer.humanAgentId, "participant first message");
    await seedSession(app, participantAgent.uuid, participantChatId);

    const managedChatId = await seedChat(app, admin.organizationId, "managed topic");
    await seedSpeaker(app, managedChatId, otherMember.humanAgentId);
    await seedSpeaker(app, managedChatId, managedAgent.uuid);
    await seedFirstMessage(app, managedChatId, otherMember.humanAgentId, "managed first message");
    await seedSession(app, managedAgent.uuid, managedChatId);

    const hiddenChatId = await seedChat(app, admin.organizationId, "hidden topic");
    await seedSpeaker(app, hiddenChatId, otherMember.humanAgentId);
    await seedSpeaker(app, hiddenChatId, hiddenAgent.uuid);
    await seedFirstMessage(app, hiddenChatId, otherMember.humanAgentId, "hidden first message");
    await seedSession(app, hiddenAgent.uuid, hiddenChatId);

    const res = await listSessions(app, viewer.accessToken, admin.organizationId, "?limit=100");
    expect(res.statusCode).toBe(200);
    const visibleChatIds = new Set(res.body.items.map((i) => i.chatId));
    expect(visibleChatIds.has(participantChatId)).toBe(true);
    expect(visibleChatIds.has(managedChatId)).toBe(true);
    expect(visibleChatIds.has(hiddenChatId)).toBe(false);
    expect(res.body.items.find((i) => i.chatId === participantChatId)).toMatchObject({
      topic: "participant topic",
      summary: "participant first message",
    });
    expect(res.body.items.find((i) => i.chatId === managedChatId)).toMatchObject({
      topic: "managed topic",
      summary: "managed first message",
    });
  });

  it("admins keep the org-wide session list but topic and summary are masked without chat access", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const otherMember = await createMember(app, admin);

    const accessibleAgent = await createAgent(app.db, {
      name: `adm-visible-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Admin Visible Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const hiddenAgent = await createAgent(app.db, {
      name: `adm-hidden-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Admin Hidden Agent",
      managerId: otherMember.memberId,
      clientId: otherMember.clientId,
    });

    const accessibleChatId = await seedChat(app, admin.organizationId, "admin visible topic");
    await seedSpeaker(app, accessibleChatId, accessibleAgent.uuid);
    await seedFirstMessage(app, accessibleChatId, accessibleAgent.uuid, "admin visible first");
    await seedSession(app, accessibleAgent.uuid, accessibleChatId);

    const hiddenChatId = await seedChat(app, admin.organizationId, "admin hidden topic");
    await seedSpeaker(app, hiddenChatId, otherMember.humanAgentId);
    await seedSpeaker(app, hiddenChatId, hiddenAgent.uuid);
    await seedFirstMessage(app, hiddenChatId, otherMember.humanAgentId, "admin hidden first");
    await seedSession(app, hiddenAgent.uuid, hiddenChatId);

    const res = await listSessions(app, admin.accessToken, admin.organizationId, "?limit=100");
    expect(res.statusCode).toBe(200);
    expect(res.body.items.some((i) => i.chatId === accessibleChatId)).toBe(true);
    expect(res.body.items.some((i) => i.chatId === hiddenChatId)).toBe(true);
    expect(res.body.items.find((i) => i.chatId === accessibleChatId)).toMatchObject({
      topic: "admin visible topic",
      summary: "admin visible first",
    });
    expect(res.body.items.find((i) => i.chatId === hiddenChatId)).toMatchObject({
      topic: null,
      summary: null,
    });
  });

  it("excludes a session row that points an own-org agent at a foreign-org chat", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    // agent_chat_sessions has independent FKs to agents and chats; nothing at
    // the DB layer ties their orgs together. Simulate a stale/malicious
    // client having reported session:state for a foreign chatId.
    const foreignOrgId = `org-${randomUUID().slice(0, 6)}`;
    await app.db.insert(organizations).values({
      id: foreignOrgId,
      name: foreignOrgId.slice(0, 30),
      displayName: "Foreign Org",
    });
    const foreignChatId = await seedChat(app, foreignOrgId, "foreign secret topic");

    const ownAgent = await createAgent(app.db, {
      name: `xchat-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Cross-chat Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    await seedSession(app, ownAgent.uuid, foreignChatId);

    const res = await listSessions(app, admin.accessToken, admin.organizationId, `?agentId=${ownAgent.uuid}&limit=100`);
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("agentId filter returns only that agent's sessions", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    const agentA = await createAgent(app.db, {
      name: `flt-a-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Filter A",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const agentB = await createAgent(app.db, {
      name: `flt-b-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Filter B",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    await seedSession(app, agentA.uuid, await seedChat(app, admin.organizationId));
    await seedSession(app, agentB.uuid, await seedChat(app, admin.organizationId));

    const res = await listSessions(app, admin.accessToken, admin.organizationId, `?agentId=${agentA.uuid}&limit=100`);
    expect(res.statusCode).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i) => i.agentId === agentA.uuid)).toBe(true);
  });

  it("state filter takes effect, and evicted sessions are hidden by default", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    const agent = await createAgent(app.db, {
      name: `st-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "State Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const activeChatId = await seedChat(app, admin.organizationId);
    const evictedChatId = await seedChat(app, admin.organizationId);
    await seedSession(app, agent.uuid, activeChatId, { state: "active" });
    await seedSession(app, agent.uuid, evictedChatId, { state: "evicted" });

    const byAgent = `agentId=${agent.uuid}&limit=100`;

    const defaults = await listSessions(app, admin.accessToken, admin.organizationId, `?${byAgent}`);
    expect(defaults.body.items.map((i) => i.chatId)).toEqual([activeChatId]);

    const evicted = await listSessions(app, admin.accessToken, admin.organizationId, `?${byAgent}&state=evicted`);
    expect(evicted.body.items.map((i) => i.chatId)).toEqual([evictedChatId]);

    const active = await listSessions(app, admin.accessToken, admin.organizationId, `?${byAgent}&state=active`);
    expect(active.body.items.map((i) => i.chatId)).toEqual([activeChatId]);
  });

  it("cursor pagination advances without overlap; malformed cursor and state are 400", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    const agent = await createAgent(app.db, {
      name: `pg-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Page Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const newerChatId = await seedChat(app, admin.organizationId);
    const olderChatId = await seedChat(app, admin.organizationId);
    await seedSession(app, agent.uuid, newerChatId, { updatedAt: new Date("2026-01-02T00:00:00Z") });
    await seedSession(app, agent.uuid, olderChatId, { updatedAt: new Date("2026-01-01T00:00:00Z") });

    const byAgent = `agentId=${agent.uuid}&limit=1`;

    const page1 = await listSessions(app, admin.accessToken, admin.organizationId, `?${byAgent}`);
    expect(page1.statusCode).toBe(200);
    expect(page1.body.items.map((i) => i.chatId)).toEqual([newerChatId]);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await listSessions(
      app,
      admin.accessToken,
      admin.organizationId,
      `?${byAgent}&cursor=${encodeURIComponent(page1.body.nextCursor ?? "")}`,
    );
    expect(page2.statusCode).toBe(200);
    expect(page2.body.items.map((i) => i.chatId)).toEqual([olderChatId]);
    expect(page2.body.nextCursor).toBeNull();

    const badCursor = await listSessions(app, admin.accessToken, admin.organizationId, "?cursor=not-a-date");
    expect(badCursor.statusCode).toBe(400);

    const badState = await listSessions(app, admin.accessToken, admin.organizationId, "?state=bogus");
    expect(badState.statusCode).toBe(400);
  });
});
