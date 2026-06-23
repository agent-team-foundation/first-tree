import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Create a non-human agent in the admin's own org (managed by the admin) so it
 * is a valid kickoff target — same `managerId` as the admin's human agent, so
 * the chat-create owner-exclusive gate passes.
 */
async function createOrgAgent(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
) {
  const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: admin.userId,
    organizationId: admin.organizationId,
    status: "connected",
  });
  return createAgent(app.db, {
    name: `bootstrap-${crypto.randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Bootstrap Agent",
    managerId: admin.memberId,
    clientId,
  });
}

const KICKOFF_URL = "/api/v1/me/onboarding/kickoff";

describe("POST /me/onboarding/kickoff", () => {
  const getApp = useTestApp();

  it("creates the chat, sends the bootstrap, and stamps completion", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);

    const res = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        organizationId: admin.organizationId,
        agentUuid: agent.uuid,
        bootstrap: "Reflect these repos.",
        kind: "tree",
      },
    });
    expect(res.statusCode).toBe(200);
    const { chatId } = res.json<{ chatId: string }>();
    expect(chatId).toBeTruthy();

    // Chat carries the kind-scoped kickoff key.
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(chat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:tree`);

    // Bootstrap message landed.
    const msgs = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("Reflect these repos.");

    // Completion stamped, with the suppressor + reason (coupled invariant).
    const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(member?.onboardingCompletedAt).not.toBeNull();
    expect(member?.onboardingSuppressedAt).not.toBeNull();
    expect(member?.onboardingSuppressedReason).toBe("completed");
  });

  it("sends kickoff as a trusted First Tree system trigger without impersonating the user", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);

    const res = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        organizationId: admin.organizationId,
        agentUuid: agent.uuid,
        bootstrap: "First Tree is getting Bootstrap Agent up to speed on acme/web.",
        kind: "work",
      },
    });
    expect(res.statusCode).toBe(200);
    const { chatId } = res.json<{ chatId: string }>();

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(chat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:work`);

    const [msg] = await app.db.select().from(messages).where(eq(messages.chatId, chatId)).limit(1);
    expect(msg?.senderId).toBe(admin.humanAgentUuid);
    expect(msg?.source).toBe("api");
    expect(msg?.format).toBe("text");
    expect(msg?.content).toBe("First Tree is getting Bootstrap Agent up to speed on acme/web.");
    expect(msg?.metadata).toEqual({ systemSender: "first_tree_onboarding" });

    const deliveries = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, msg?.id ?? ""));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.notify).toBe(true);
    expect(res.json<{ chatId: string }>().chatId).toBe(chatId);
  });

  it("can defer completion for multi-chat onboarding until the caller finishes all required chats", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const base = {
      organizationId: admin.organizationId,
      agentUuid: agent.uuid,
      complete: false,
    };

    const work = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...base, bootstrap: "Start with useful work.", kind: "work" },
    });
    expect(work.statusCode).toBe(200);

    const [afterWork] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(afterWork?.onboardingCompletedAt).toBeNull();
    expect(afterWork?.onboardingSuppressedAt).toBeNull();
    expect(afterWork?.onboardingSuppressedReason).toBeNull();

    const tree = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...base, bootstrap: "Seed the Context Tree.", kind: "tree" },
    });
    expect(tree.statusCode).toBe(200);

    const [afterTree] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(afterTree?.onboardingCompletedAt).toBeNull();
    expect(afterTree?.onboardingSuppressedAt).toBeNull();
    expect(afterTree?.onboardingSuppressedReason).toBeNull();

    const complete = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { organizationId: admin.organizationId },
    });
    expect(complete.statusCode).toBe(200);

    const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(member?.onboardingCompletedAt).not.toBeNull();
    expect(member?.onboardingSuppressedAt).not.toBeNull();
    expect(member?.onboardingSuppressedReason).toBe("completed");
  });

  it("is idempotent — a second call reuses the chat, sends no duplicate, keeps the stamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const payload = {
      organizationId: admin.organizationId,
      agentUuid: agent.uuid,
      bootstrap: "Hello team.",
      kind: "tree" as const,
    };

    const first = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    const firstChatId = first.json<{ chatId: string }>().chatId;
    const [firstMember] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    const firstStamp = firstMember?.onboardingCompletedAt;

    // Advance the clock so a re-stamp would be detectable.
    await new Promise((r) => setTimeout(r, 10));

    const second = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ chatId: string }>().chatId).toBe(firstChatId);

    // Exactly one kickoff chat for this (human, agent, kind) triple.
    const kickoffChats = await app.db
      .select()
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:tree`));
    expect(kickoffChats).toHaveLength(1);

    // No duplicate bootstrap.
    const msgs = await app.db.select().from(messages).where(eq(messages.chatId, firstChatId));
    expect(msgs).toHaveLength(1);

    // Original completion stamp preserved (not reset).
    const [secondMember] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(secondMember?.onboardingCompletedAt?.getTime()).toBe(firstStamp?.getTime());
  });

  it("concurrent kickoffs converge on a single chat with a single bootstrap", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const payload = {
      organizationId: admin.organizationId,
      agentUuid: agent.uuid,
      bootstrap: "Race.",
      kind: "tree" as const,
    };
    const inject = () =>
      app.inject({
        method: "POST",
        url: KICKOFF_URL,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload,
      });

    const [a, b] = await Promise.all([inject(), inject()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const chatId = a.json<{ chatId: string }>().chatId;
    expect(b.json<{ chatId: string }>().chatId).toBe(chatId);

    const kickoffChats = await app.db
      .select()
      .from(chats)
      .where(and(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:tree`)));
    expect(kickoffChats).toHaveLength(1);

    // The row-lock guard means exactly one bootstrap, even racing.
    const msgs = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msgs).toHaveLength(1);
  });

  it("keeps intro and tree kickoffs as separate chats so /build-tree still wakes the agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const base = { organizationId: admin.organizationId, agentUuid: agent.uuid };

    // 1) Admin finishes onboarding with no repo → intro kickoff.
    const intro = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...base, bootstrap: "Meet your agent.", kind: "intro" },
    });
    const introChatId = intro.json<{ chatId: string }>().chatId;

    // 2) Later, /build-tree with the SAME agent → tree kickoff. Must be a NEW
    //    chat carrying the tree-seeding bootstrap, not the intro chat (regression
    //    for the over-broad key that skipped the seed task).
    const tree = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...base, bootstrap: "Seed the team tree.", kind: "tree" },
    });
    const treeChatId = tree.json<{ chatId: string }>().chatId;

    expect(treeChatId).not.toBe(introChatId);
    const treeMsgs = await app.db.select().from(messages).where(eq(messages.chatId, treeChatId));
    expect(treeMsgs).toHaveLength(1);
    expect(treeMsgs[0]?.content).toBe("Seed the team tree.");
  });
});
