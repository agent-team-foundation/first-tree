/**
 * HTTP-level tests for `POST /me/chats` — the chat-first workspace's
 * member-facing chat-create endpoint.
 *
 * Regression target: a multi-org user creating a chat with an agent in a
 * non-default org used to receive `Cross-organization chat not allowed: …`,
 * because the handler resolved the chat's org from `memberScope` (JWT
 * default) instead of the target participant's actual org. Mirrors the
 * #222 fix shape (which covered the parallel `/admin/agents/:uuid/chats`
 * surface) for the `/me/chats*` surface introduced in the chat-first
 * workspace.
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("POST /me/chats — multi-org resolution", () => {
  const getApp = useTestApp();

  /**
   * Stand up a second org and attach `userId` to it. Mirrors the helper in
   * admin-agents.test.ts. Returns the org's id and the caller's human-agent
   * id within it (so tests can assert it became a participant of the chat).
   */
  async function attachOrg(
    app: FastifyInstance,
    userId: string,
    role: "admin" | "member",
  ): Promise<{ orgId: string; memberId: string; humanAgentId: string }> {
    const orgId = `org-mechats-${crypto.randomUUID().slice(0, 8)}`;
    const memberId = uuidv7();
    let humanAgentId = "";
    await app.db.transaction(async (tx) => {
      await tx
        .insert(organizations)
        .values({ id: orgId, name: `mechats-${crypto.randomUUID().slice(0, 6)}`, displayName: "MeChats Side" });
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `mechats-h-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "MeChats Human",
        managerId: memberId,
        organizationId: orgId,
      });
      humanAgentId = human.uuid;
      await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
    });
    return { orgId, memberId, humanAgentId };
  }

  it("creates a direct chat when the target agent lives in a non-default org", async () => {
    const app = getApp();
    const alice = await createAdminContext(app);
    const orgB = await attachOrg(app, alice.userId, "admin");

    // Agent in non-default org B, managed by Alice's org-B member. Alice's
    // JWT default org is the one `createAdminContext` set up for her.
    const target = await createAgent(app.db, {
      name: `target-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Target",
      managerId: orgB.memberId,
      clientId: alice.clientId,
      organizationId: orgB.orgId,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [target.uuid] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ chatId: string }>();
    expect(typeof body.chatId).toBe("string");

    // Verify the chat was created in org B (not Alice's default org) and
    // that Alice's org-B human agent is a participant — not her default-org
    // human, which would have been the buggy outcome.
    const { chats } = await import("../db/schema/chats.js");
    const { chatParticipants } = await import("../db/schema/chats.js");
    const { eq } = await import("drizzle-orm");
    const [chatRow] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(chatRow?.organizationId).toBe(orgB.orgId);
    const parts = await app.db
      .select({ agentId: chatParticipants.agentId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, body.chatId));
    const ids = parts.map((p) => p.agentId);
    expect(ids).toContain(target.uuid);
    expect(ids).toContain(orgB.humanAgentId);
  });

  it("400s when the caller has no membership in the target agent's org", async () => {
    const app = getApp();
    const alice = await createAdminContext(app);

    // Bob's separate org; Alice is NOT a member.
    const bobOrgId = `org-mechats-bob-${crypto.randomUUID().slice(0, 8)}`;
    const bobMemberId = uuidv7();
    const bobUserId = uuidv7();
    const targetUuid = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: bobUserId,
        username: `bob-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "$2b$04$xxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
        displayName: "Bob",
      });
      await tx.insert(organizations).values({ id: bobOrgId, name: bobOrgId.slice(0, 30), displayName: "Bob's Org" });
      const bobHuman = await createAgent(tx as unknown as typeof app.db, {
        name: `bob-h-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Bob Human",
        managerId: bobMemberId,
        organizationId: bobOrgId,
      });
      await tx.insert(members).values({
        id: bobMemberId,
        userId: bobUserId,
        organizationId: bobOrgId,
        agentId: bobHuman.uuid,
        role: "admin",
      });
      const bobAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `bob-target-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Bob's Target",
        managerId: bobMemberId,
        organizationId: bobOrgId,
      });
      return bobAgent.uuid;
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [targetUuid] },
    });
    // `requireMemberInOrg` raises ForbiddenError → 403.
    expect(res.statusCode).toBe(403);
  });

  it("still works when the target agent is in the caller's default org (no regression)", async () => {
    const app = getApp();
    const alice = await createAdminContext(app);

    const target = await createAgent(app.db, {
      name: `default-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Default Target",
      managerId: alice.memberId,
      clientId: alice.clientId,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [target.uuid] },
    });
    expect(res.statusCode).toBe(201);
  });

  it("400s when no non-self participants are supplied", async () => {
    const app = getApp();
    const alice = await createAdminContext(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/chats",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [alice.humanAgentUuid] },
    });
    expect(res.statusCode).toBe(400);
  });
});
