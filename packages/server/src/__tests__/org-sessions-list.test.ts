import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * Filter integrity for `GET /orgs/:orgId/sessions` (listAllSessions).
 *
 * Visibility policy: any active org member may read every org session's
 * topic/summary — that is accepted product behavior. What these tests pin
 * down is that every query filter actually takes effect:
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

  type SessionItem = { agentId: string; chatId: string; state: string; topic: string | null };
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
    await seedSession(app, ownAgent.uuid, ownChatId);

    const own = await listSessions(app, admin.accessToken, admin.organizationId, "?limit=100");
    expect(own.statusCode).toBe(200);
    expect(own.body.items.some((i) => i.chatId === ownChatId)).toBe(true);
    expect(own.body.items.some((i) => i.chatId === foreignChatId)).toBe(false);
    expect(own.body.items.find((i) => i.chatId === ownChatId)?.topic).toBe("own topic");

    const foreign = await listSessions(app, admin.accessToken, foreignOrgId);
    expect(foreign.statusCode).toBe(403);
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
