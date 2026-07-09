import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Regression coverage for #238: the old `POST /me/chats` resolved the
 * creator's org via heuristics (first-participant's org, JWT default org)
 * and then bounced on a cross-org guard if the dropdown didn't agree. Post
 * the JWT-scope-strip refactor that endpoint moved to
 * `POST /orgs/:orgId/chats`, where the org is path-explicit and
 * `requireOrgMembership` resolves the creator from `members(userId, orgId)`
 * directly. The bug class no longer has a hiding place.
 *
 * The Class C equivalent path (`POST /agents/:uuid/chats` cross-org) is
 * already covered in `admin-agents.test.ts:268`. This file pins the
 * Class B path so any future refactor that re-introduces JWT-default-org
 * heuristics in the chat-create handler fails at the HTTP boundary.
 */

async function attachOrg(
  app: FastifyInstance,
  userId: string,
  role: "admin" | "member",
): Promise<{ orgId: string; memberId: string; humanAgentId: string }> {
  const orgId = `org-oc-${crypto.randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  let humanAgentId = "";
  await app.db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: orgId, name: `oc-${crypto.randomUUID().slice(0, 6)}`, displayName: "Orgs Chats Side" });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `oc-h-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Orgs Chats Human",
      managerId: memberId,
      organizationId: orgId,
    });
    humanAgentId = human.uuid;
    await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
  });
  return { orgId, memberId, humanAgentId };
}

describe("POST /orgs/:orgId/chats — multi-org chat creation (regression #238)", () => {
  const getApp = useTestApp();

  it("non-default org member can start a chat with an agent in that org", async () => {
    const app = getApp();
    // Alice's primary org is the one createTestAdmin returns; she's a
    // separate member in orgB. Targeting orgB via the URL is what used to
    // trip the old heuristic.
    const alice = await createTestAdmin(app);
    const orgB = await attachOrg(app, alice.userId, "member");
    const target = await createAgent(app.db, {
      name: `oc-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Orgs Chats Target",
      managerId: orgB.memberId,
      organizationId: orgB.orgId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [target.uuid] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ chatId: string }>();
    expect(typeof body.chatId).toBe("string");
    expect(body.chatId.length).toBeGreaterThan(0);
  });

  it("task mode creates the chat and first Web message through the org route", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `oc-task-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Task Target",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        mode: "task",
        initialRecipientAgentIds: [target.uuid],
        initialRecipientNames: [],
        contextParticipantAgentIds: [],
        contextParticipantNames: [],
        topic: "Web task create",
        initialMessage: { source: "web", format: "text", content: "start from web" },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ chatId: string; messageId: string; effectiveSenderId: string }>();
    expect(body.effectiveSenderId).toBe(alice.humanAgentUuid);

    const [chatRow] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(chatRow?.metadata).toEqual({});
    expect(chatRow?.topic).toBe("Web task create");

    const [messageRow] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(messageRow).toMatchObject({
      chatId: body.chatId,
      senderId: alice.humanAgentUuid,
      source: "web",
      format: "text",
      content: "start from web",
    });
    expect(messageRow?.metadata).toEqual({
      mentions: [target.uuid],
      addressedAgentIds: [target.uuid],
    });
  });

  it("admin all-scope listing serializes chat rows and pagination metadata", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const chatId = `chat-oc-list-${crypto.randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: admin.organizationId,
      type: "group",
      topic: "All chats row",
      lifecyclePolicy: "manual",
      metadata: { source: "test" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats?scope=all&limit=1`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{ id: string; topic: string; participantCount: number }>;
      nextCursor: string | null;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: chatId, topic: "All chats row", participantCount: 0 });
    expect(body.nextCursor).toBeNull();
  });

  it("lists source counts and rejects self-only manual chat creation before visibility lookup", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const counts = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats/source-counts`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(counts.statusCode).toBe(200);
    expect(counts.json<{ counts: { manual?: { chatCount: number } } }>().counts.manual).toEqual({
      chatCount: 0,
      unreadChatCount: 0,
    });

    const selfOnly = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { participantIds: [admin.humanAgentUuid] },
    });
    expect(selfOnly.statusCode).toBe(400);
    expect(selfOnly.json<{ error: string }>().error).toContain("At least one non-self participant required");
  });

  it("rejects participants from a different org (404 — anti-enumeration, not 400)", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgB = await attachOrg(app, alice.userId, "member");
    // Target lives in Alice's default org A — invalid participant for an orgB chat.
    const targetInA = await createAgent(app.db, {
      name: `oc-stray-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Stray Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [targetInA.uuid] },
    });
    // `assertAllAgentsVisibleInOrg` returns 404 (not 400) so a non-member
    // can't probe whether a uuid exists in another org by interpreting the
    // error code. This is the same anti-enumeration pattern that
    // `requireAgentAccess` uses.
    expect(res.statusCode).toBe(404);
  });

  it("rejects when caller has no active membership in the URL's org (403)", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    // orgC exists but Alice is NOT attached as a member.
    const orgC = `org-oc-c-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(organizations).values({ id: orgC, name: orgC.slice(0, 30), displayName: "Outside" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(orgC)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: ["any-uuid-doesnt-matter"] },
    });
    expect(res.statusCode).toBe(403);
  });
});
