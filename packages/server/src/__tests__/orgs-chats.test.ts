import { AGENT_STATUSES } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
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

async function tableCount(app: FastifyInstance, table: typeof chats | typeof messages) {
  const [row] = await app.db.select({ count: sql<number>`count(*)::int` }).from(table);
  return row?.count ?? 0;
}

async function chatAndMessageCounts(app: FastifyInstance) {
  return {
    chats: await tableCount(app, chats),
    messages: await tableCount(app, messages),
  };
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

describe("POST /orgs/:orgId/chats/create-and-send", () => {
  const getApp = useTestApp();

  it("creates a Web chat and persists the first text message with source=web", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `web-create-text-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create Text",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats/create-and-send`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        participantIds: [target.uuid],
        message: { format: "text", content: "hello from web", metadata: { mentions: [target.uuid] } },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ chatId: string; messageId: string }>();
    expect(typeof body.chatId).toBe("string");
    expect(typeof body.messageId).toBe("string");

    const [message] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(message).toMatchObject({
      chatId: body.chatId,
      senderId: alice.humanAgentUuid,
      source: "web",
      format: "text",
      content: "hello from web",
    });
    expect(message?.metadata.mentions).toEqual([target.uuid]);
  });

  it("creates a Web chat with a file initial message after the browser uploads attachments", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `web-create-file-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create File",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });

    const attachment = {
      imageId: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "draft.png",
      size: 123,
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats/create-and-send`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        participantIds: [target.uuid],
        message: {
          format: "file",
          content: { caption: "see image", attachments: [attachment] },
          metadata: { mentions: [target.uuid] },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ chatId: string; messageId: string }>();
    const [message] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(message?.source).toBe("web");
    expect(message?.format).toBe("file");
    expect(message?.content).toEqual({ caption: "see image", attachments: [attachment] });
  });

  it("rejects a missing initial message recipient before creating the chat", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `web-create-missing-recipient-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create Missing Recipient",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const initialCounts = await chatAndMessageCounts(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats/create-and-send`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        participantIds: [target.uuid],
        message: { format: "text", content: "hello without recipient" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("requires at least one non-self message recipient mention"),
    });
    expect(await chatAndMessageCounts(app)).toEqual(initialCounts);
  });

  it("rejects an initial message recipient outside the new chat participants before creating the chat", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const participant = await createAgent(app.db, {
      name: `web-create-participant-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create Participant",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const mentioned = await createAgent(app.db, {
      name: `web-create-mentioned-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create Mentioned",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const initialCounts = await chatAndMessageCounts(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats/create-and-send`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        participantIds: [participant.uuid],
        message: {
          format: "text",
          content: "hello to outside recipient",
          metadata: { mentions: [mentioned.uuid] },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("must be a participant of the new chat"),
    });
    expect(await chatAndMessageCounts(app)).toEqual(initialCounts);
  });

  it("rejects an inactive initial message recipient before creating the chat", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `web-create-suspended-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create Suspended",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    await app.db.update(agents).set({ status: AGENT_STATUSES.SUSPENDED }).where(eq(agents.uuid, target.uuid));
    const initialCounts = await chatAndMessageCounts(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats/create-and-send`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        participantIds: [target.uuid],
        message: {
          format: "text",
          content: "hello to suspended recipient",
          metadata: { mentions: [target.uuid] },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("agent is suspended"),
    });
    expect(await chatAndMessageCounts(app)).toEqual(initialCounts);
  });

  it("returns structured partial failure and leaves an empty chat if initial send fails after creation", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `web-create-fail-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Web Create Fail",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const initialChatCount = await tableCount(app, chats);
    const initialMessageCount = await tableCount(app, messages);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats/create-and-send`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        participantIds: [target.uuid],
        message: {
          format: "file",
          content: {
            attachments: [
              {
                imageId: "11111111-1111-4111-8111-111111111111",
                mimeType: "text/plain",
                filename: "bad.txt",
              },
            ],
          },
          metadata: { mentions: [target.uuid] },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "CHAT_CREATE_INITIAL_MESSAGE_FAILED",
      details: { cause: expect.any(String), chatId: expect.any(String) },
    });
    expect(await tableCount(app, chats)).toBe(initialChatCount + 1);
    expect(await tableCount(app, messages)).toBe(initialMessageCount);
  });
});
