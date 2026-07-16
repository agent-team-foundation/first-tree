import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
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
const treeKickoffUrl = (organizationId: string): string => `/api/v1/orgs/${organizationId}/context-tree/setup-chat`;
const TREE_STATUS_URL = "/api/v1/me/onboarding/tree-setup-status";

describe("POST /me/onboarding/kickoff", () => {
  const getApp = useTestApp({ growthLandingPagesEnabled: true });
  const getGrowthDisabledApp = useTestApp();

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
        topic: "Get started with First Tree",
      },
    });
    expect(res.statusCode).toBe(200);
    const { chatId } = res.json<{ chatId: string }>();
    expect(chatId).toBeTruthy();

    // Chat carries the onboarding-scoped kickoff key.
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(chat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:onboarding`);
    expect(chat?.topic).toBe("Get started with First Tree");

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

  it("sends kickoff as a visible task message that wakes the target agent", async () => {
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
        topic: "Get started with First Tree",
      },
    });
    expect(res.statusCode).toBe(200);
    const { chatId } = res.json<{ chatId: string }>();

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(chat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:onboarding`);
    expect(chat?.topic).toBe("Get started with First Tree");

    const [msg] = await app.db.select().from(messages).where(eq(messages.chatId, chatId)).limit(1);
    expect(msg?.senderId).toBe(admin.humanAgentUuid);
    expect(msg?.source).toBe("api");
    expect(msg?.format).toBe("text");
    expect(msg?.content).toBe("First Tree is getting Bootstrap Agent up to speed on acme/web.");
    expect(msg?.metadata).toEqual({
      mentions: [agent.uuid],
      addressedAgentIds: [agent.uuid],
    });

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
      payload: { ...base, bootstrap: "Start with useful work.", topic: "Get started with First Tree" },
    });
    expect(work.statusCode).toBe(200);

    const [afterWork] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(afterWork?.onboardingCompletedAt).toBeNull();
    expect(afterWork?.onboardingSuppressedAt).toBeNull();
    expect(afterWork?.onboardingSuppressedReason).toBeNull();

    const tree = await app.inject({
      method: "POST",
      url: treeKickoffUrl(admin.organizationId),
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: agent.uuid },
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

  it("team-agent start (stamp=invitee_skip) suppresses auto-open without stamping completion", async () => {
    const app = getApp();
    // The agent's manager: an ordinary teammate whose org-visible agent the
    // joining member starts with.
    const owner = await createTestAdmin(app, { username: `owner-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createOrgAgent(app, owner);
    await app.db.update(agents).set({ visibility: "organization" }).where(eq(agents.uuid, agent.uuid));

    // The joining member: same org (createTestAdmin shares the default org),
    // no personal agent, not the target agent's manager.
    const joiner = await createTestAdmin(app, { username: `joiner-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, joiner.memberId));

    const payload = {
      organizationId: joiner.organizationId,
      agentUuid: agent.uuid,
      bootstrap: "Bootstrap Agent, hi — I just joined the team.",
      topic: "Get settled on First Tree",
      stamp: "invitee_skip",
    };
    const res = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${joiner.accessToken}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const { chatId } = res.json<{ chatId: string }>();

    // The chat is keyed per (joining human, team agent) like any onboarding kickoff.
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(chat?.onboardingKickoffKey).toBe(`${joiner.humanAgentUuid}:${agent.uuid}:onboarding`);

    // Suppressor stamped with the invitee_skip reason; completion NOT stamped —
    // the standard connect-computer → create-agent journey stays pending.
    const [joinerMember] = await app.db.select().from(members).where(eq(members.id, joiner.memberId)).limit(1);
    expect(joinerMember?.onboardingSuppressedAt).not.toBeNull();
    expect(joinerMember?.onboardingSuppressedReason).toBe("invitee_skip");
    expect(joinerMember?.onboardingCompletedAt).toBeNull();

    // The agent owner's own onboarding state is untouched.
    const [ownerMember] = await app.db.select().from(members).where(eq(members.id, owner.memberId)).limit(1);
    expect(ownerMember?.onboardingSuppressedAt).toBeNull();
    expect(ownerMember?.onboardingCompletedAt).toBeNull();

    // Retry converges: same chat, no duplicate bootstrap, stamps unchanged.
    const retry = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${joiner.accessToken}` },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ chatId: string }>().chatId).toBe(chatId);
    const msgs = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msgs).toHaveLength(1);
    const [afterRetry] = await app.db.select().from(members).where(eq(members.id, joiner.memberId)).limit(1);
    expect(afterRetry?.onboardingSuppressedAt?.getTime()).toBe(joinerMember?.onboardingSuppressedAt?.getTime());
    expect(afterRetry?.onboardingCompletedAt).toBeNull();
  });

  it("invitee_skip never overwrites an existing suppressor or downgrades a completed membership", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);

    // Membership already terminally completed (completion writes both stamps).
    const completedAt = new Date("2026-01-01T00:00:00Z");
    await app.db
      .update(members)
      .set({
        onboardingCompletedAt: completedAt,
        onboardingSuppressedAt: completedAt,
        onboardingSuppressedReason: "completed",
      })
      .where(eq(members.id, admin.memberId));

    const res = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        organizationId: admin.organizationId,
        agentUuid: agent.uuid,
        bootstrap: "Start another chat after completion.",
        topic: "Get settled on First Tree",
        stamp: "invitee_skip",
      },
    });
    expect(res.statusCode).toBe(200);

    const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(member?.onboardingSuppressedReason).toBe("completed");
    expect(member?.onboardingSuppressedAt?.getTime()).toBe(completedAt.getTime());
    expect(member?.onboardingCompletedAt?.getTime()).toBe(completedAt.getTime());
  });

  it("is idempotent — a second call reuses the chat, sends no duplicate, keeps the stamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const payload = {
      organizationId: admin.organizationId,
      agentUuid: agent.uuid,
      bootstrap: "Hello team.",
      topic: "Get started with First Tree",
    };

    const first = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    const firstChatId = first.json<{ chatId: string }>().chatId;
    await app.db.update(chats).set({ topic: "Custom kickoff title" }).where(eq(chats.id, firstChatId));
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

    // Exactly one kickoff chat for this onboarding pair.
    const kickoffChats = await app.db
      .select()
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:onboarding`));
    expect(kickoffChats).toHaveLength(1);
    expect(kickoffChats[0]?.topic).toBe("Custom kickoff title");

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
      topic: "Get started with First Tree",
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
      .where(and(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:onboarding`)));
    expect(kickoffChats).toHaveLength(1);

    // The row-lock guard means exactly one bootstrap, even racing.
    const msgs = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msgs).toHaveLength(1);
  });

  it("keeps onboarding and tree setup kickoffs as separate chats so /context still wakes the agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const base = { organizationId: admin.organizationId, agentUuid: agent.uuid };

    // 1) Admin finishes onboarding with no repo → normal onboarding kickoff.
    const intro = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        ...base,
        bootstrap: "Nova, welcome aboard.\n\nPlease help me get started with First Tree.",
        topic: "Get started with First Tree",
      },
    });
    const introChatId = intro.json<{ chatId: string }>().chatId;
    const [introChat] = await app.db.select().from(chats).where(eq(chats.id, introChatId)).limit(1);
    expect(introChat?.topic).toBe("Get started with First Tree");

    // 2) Later, /context with the SAME agent → dedicated tree setup kickoff.
    //    Must be a NEW chat carrying the tree-seeding bootstrap, not the
    //    onboarding chat.
    const tree = await app.inject({
      method: "POST",
      url: treeKickoffUrl(admin.organizationId),
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: agent.uuid },
    });
    const treeChatId = tree.json<{ chatId: string }>().chatId;
    const [treeChat] = await app.db.select().from(chats).where(eq(chats.id, treeChatId)).limit(1);
    expect(treeChat?.topic).toBe("Set up shared context");
    expect(treeChat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:tree-setup`);

    expect(treeChatId).not.toBe(introChatId);
    const treeMsgs = await app.db.select().from(messages).where(eq(messages.chatId, treeChatId));
    expect(treeMsgs).toHaveLength(1);
    expect(treeMsgs[0]?.content).toContain("Let's build or finish our team's Context Tree.");
    expect(treeMsgs[0]?.content).toContain("A non-empty source manifest is authoritative");
    expect(treeMsgs[0]?.content).toContain("missing declared clone as a blocking half-provisioned workspace");
    expect(treeMsgs[0]?.content).toContain("Only when the manifest is empty or absent");
    expect(treeMsgs[0]?.content).toContain("local project folder path or GitHub repository URL");
    expect(treeMsgs[0]?.content).toContain("Use this same chat to continue after approval");
    expect(treeMsgs[0]?.content).not.toContain("GitHub App");
  });

  it("starts a new recovery chat with the current server-resolved snapshot diagnostic", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const repo = `https://localhost:1/acme/unreadable-${crypto.randomUUID()}.git`;
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { repo, branch: "release" },
      updatedBy: admin.userId,
    });

    const response = await app.inject({
      method: "POST",
      url: treeKickoffUrl(admin.organizationId),
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: agent.uuid },
    });

    expect(response.statusCode).toBe(200);
    const chatId = response.json<{ chatId: string }>().chatId;
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0]?.content).toContain("Current server-resolved recovery diagnostic:");
    expect(chatMessages[0]?.content).toContain(`Configured repository: ${repo}`);
    expect(chatMessages[0]?.content).toContain("Configured branch: release");
    expect(chatMessages[0]?.content).toContain("Snapshot status: unavailable");
    expect(chatMessages[0]?.metadata).toMatchObject({
      contextTreeRecoveryFingerprint: expect.any(String),
      mentions: [agent.uuid],
      addressedAgentIds: [agent.uuid],
    });
    const deliveries = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, chatMessages[0]?.id ?? ""));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.notify).toBe(true);
  });

  it("appends and wakes on recovery in an existing setup chat, but deduplicates an immediate retry", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const open = () =>
      app.inject({
        method: "POST",
        url: treeKickoffUrl(admin.organizationId),
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { agentUuid: agent.uuid },
      });

    const initial = await open();
    const chatId = initial.json<{ chatId: string }>().chatId;
    const repo = `https://localhost:1/acme/unreadable-${crypto.randomUUID()}.git`;
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { repo, branch: "main" },
      updatedBy: admin.userId,
    });

    const [recovery, retry] = await Promise.all([open(), open()]);
    expect(recovery.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(recovery.json<{ chatId: string }>().chatId).toBe(chatId);
    expect(retry.json<{ chatId: string }>().chatId).toBe(chatId);

    const chatMessages = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(messages.createdAt, messages.id);
    expect(chatMessages).toHaveLength(2);
    expect(chatMessages[0]?.content).not.toContain("Current server-resolved recovery diagnostic:");
    expect(chatMessages[1]?.content).toContain("Current server-resolved recovery diagnostic:");
    expect(chatMessages[1]?.content).toContain(`Configured repository: ${repo}`);
    expect(chatMessages[1]?.metadata).toMatchObject({
      contextTreeRecoveryFingerprint: expect.any(String),
      addressedAgentIds: [agent.uuid],
    });
    const recoveryDeliveries = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, chatMessages[1]?.id ?? ""));
    expect(recoveryDeliveries).toHaveLength(1);
    expect(recoveryDeliveries[0]?.notify).toBe(true);
  });

  it("safely re-keys and reuses a legacy org setup chat with the exact same private boundary", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const legacyChatId = `chat-${crypto.randomUUID()}`;
    await app.db.insert(chats).values({
      id: legacyChatId,
      organizationId: admin.organizationId,
      type: "group",
      topic: "Set up shared context",
      onboardingKickoffKey: `${admin.organizationId}:tree-setup`,
    });
    await app.db.insert(chatMembership).values([
      {
        chatId: legacyChatId,
        agentId: admin.humanAgentUuid,
        role: "owner",
        accessMode: "speaker",
        mode: "mention_only",
      },
      {
        chatId: legacyChatId,
        agentId: agent.uuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
      },
    ]);
    await app.db.insert(messages).values({
      id: `msg-${crypto.randomUUID()}`,
      chatId: legacyChatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "Our approved Phase 1 history.",
      source: "api",
      metadata: { mentions: [agent.uuid], addressedAgentIds: [agent.uuid] },
    });

    const response = await app.inject({
      method: "POST",
      url: treeKickoffUrl(admin.organizationId),
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: agent.uuid },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ chatId: string }>().chatId).toBe(legacyChatId);
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, legacyChatId)).limit(1);
    expect(chat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:tree-setup`);
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, legacyChatId));
    expect(chatMessages.map((message) => message.content)).toEqual(["Our approved Phase 1 history."]);
  });

  it("does not adopt a legacy org setup chat owned by another admin and private agent", async () => {
    const app = getApp();
    const firstAdmin = await createTestAdmin(app);
    const laterAdmin = await createTestAdmin(app);
    const firstAgent = await createOrgAgent(app, firstAdmin);
    const laterAgent = await createOrgAgent(app, laterAdmin);
    const legacyChatId = `chat-${crypto.randomUUID()}`;
    await app.db.insert(chats).values({
      id: legacyChatId,
      organizationId: firstAdmin.organizationId,
      type: "group",
      topic: "Set up shared context",
      onboardingKickoffKey: `${firstAdmin.organizationId}:tree-setup`,
    });
    await app.db.insert(chatMembership).values([
      {
        chatId: legacyChatId,
        agentId: firstAdmin.humanAgentUuid,
        role: "owner",
        accessMode: "speaker",
        mode: "mention_only",
      },
      {
        chatId: legacyChatId,
        agentId: firstAgent.uuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: treeKickoffUrl(firstAdmin.organizationId),
      headers: { authorization: `Bearer ${laterAdmin.accessToken}` },
      payload: { agentUuid: laterAgent.uuid },
    });

    expect(response.statusCode).toBe(200);
    const laterChatId = response.json<{ chatId: string }>().chatId;
    expect(laterChatId).not.toBe(legacyChatId);
    const [legacy] = await app.db.select().from(chats).where(eq(chats.id, legacyChatId)).limit(1);
    expect(legacy?.onboardingKickoffKey).toBe(`${firstAdmin.organizationId}:tree-setup`);
    const legacySpeakers = await app.db.select().from(chatMembership).where(eq(chatMembership.chatId, legacyChatId));
    expect(new Set(legacySpeakers.map((speaker) => speaker.agentId))).toEqual(
      new Set([firstAdmin.humanAgentUuid, firstAgent.uuid]),
    );
  });

  it("keeps each admin's setup chat inside their own private-agent boundary", async () => {
    const app = getApp();
    const firstAdmin = await createTestAdmin(app);
    const laterAdmin = await createTestAdmin(app);
    expect(laterAdmin.organizationId).toBe(firstAdmin.organizationId);
    const firstAgent = await createOrgAgent(app, firstAdmin);
    const laterAgent = await createOrgAgent(app, laterAdmin);

    const first = await app.inject({
      method: "POST",
      url: treeKickoffUrl(firstAdmin.organizationId),
      headers: { authorization: `Bearer ${firstAdmin.accessToken}` },
      payload: { agentUuid: firstAgent.uuid },
    });
    const later = await app.inject({
      method: "POST",
      url: treeKickoffUrl(firstAdmin.organizationId),
      headers: { authorization: `Bearer ${laterAdmin.accessToken}` },
      payload: { agentUuid: laterAgent.uuid },
    });

    expect(first.statusCode).toBe(200);
    expect(later.statusCode).toBe(200);
    const firstChatId = first.json<{ chatId: string }>().chatId;
    const laterChatId = later.json<{ chatId: string }>().chatId;
    expect(laterChatId).not.toBe(firstChatId);

    const firstSpeakers = await app.db.select().from(chatMembership).where(eq(chatMembership.chatId, firstChatId));
    expect(new Set(firstSpeakers.map((speaker) => speaker.agentId))).toEqual(
      new Set([firstAdmin.humanAgentUuid, firstAgent.uuid]),
    );
    const laterSpeakers = await app.db.select().from(chatMembership).where(eq(chatMembership.chatId, laterChatId));
    expect(new Set(laterSpeakers.map((speaker) => speaker.agentId))).toEqual(
      new Set([laterAdmin.humanAgentUuid, laterAgent.uuid]),
    );

    const setupRows = await app.db
      .select({ key: chats.onboardingKickoffKey })
      .from(chats)
      .where(eq(chats.organizationId, firstAdmin.organizationId));
    expect(new Set(setupRows.map((row) => row.key))).toEqual(
      new Set([
        `${firstAdmin.humanAgentUuid}:${firstAgent.uuid}:tree-setup`,
        `${laterAdmin.humanAgentUuid}:${laterAgent.uuid}:tree-setup`,
      ]),
    );
  });

  it("requires an org admin and rejects body-controlled org or completion fields", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));

    const memberResponse = await app.inject({
      method: "POST",
      url: treeKickoffUrl(admin.organizationId),
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: agent.uuid },
    });
    expect(memberResponse.statusCode).toBe(403);

    await app.db.update(members).set({ role: "admin" }).where(eq(members.id, admin.memberId));
    const staleBody = await app.inject({
      method: "POST",
      url: treeKickoffUrl(admin.organizationId),
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        organizationId: admin.organizationId,
        agentUuid: agent.uuid,
        complete: true,
      },
    });
    expect(staleBody.statusCode).toBe(400);

    const rows = await app.db
      .select()
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:tree-setup`));
    expect(rows).toHaveLength(0);
  });

  it("rejects campaign kickoff when growth landing pages are enabled because campaigns moved to landing-campaigns/start", async () => {
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
        bootstrap: "Welcome - let's scan acme/api.",
        complete: false,
        campaign: "production-scan",
      },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: "campaign_kickoff_moved" });
    const rows = await app.db
      .select()
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:quickstart:production-scan`));
    expect(rows).toHaveLength(0);
  });

  it("rejects legacy kind=tree on the first-chat kickoff endpoint", async () => {
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
        bootstrap: "Seed the legacy tree.",
        kind: "tree",
        complete: false,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "stale_onboarding_kickoff_contract" });
    const rows = await app.db.select().from(chats).where(eq(chats.organizationId, admin.organizationId));
    expect(rows).toHaveLength(0);
  });

  it("rejects campaign kickoff when growth landing pages are disabled", async () => {
    const app = getGrowthDisabledApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);

    const res = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        organizationId: admin.organizationId,
        agentUuid: agent.uuid,
        bootstrap: "Campaign work kickoff.",
        campaign: "production-scan",
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "feature_disabled" });
    const rows = await app.db
      .select()
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, `${admin.humanAgentUuid}:${agent.uuid}:quickstart:production-scan`));
    expect(rows).toHaveLength(0);
  });

  it("uses the onboarding key when no campaign is passed", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const base = {
      organizationId: admin.organizationId,
      agentUuid: agent.uuid,
      complete: false,
    };

    const legacy = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...base, bootstrap: "Onboarding kickoff.", topic: "Get started with First Tree" },
    });
    expect(legacy.statusCode).toBe(200);
    const legacyChatId = legacy.json<{ chatId: string }>().chatId;

    const [legacyChat] = await app.db.select().from(chats).where(eq(chats.id, legacyChatId)).limit(1);
    expect(legacyChat?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:onboarding`);

    // Campaign quickstart no longer shares this endpoint, so the legacy
    // onboarding key remains the only chat created through kickoff.
    const campaign = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        ...base,
        bootstrap: "Campaign work kickoff.",
        topic: "Production readiness scan",
        campaign: "production-scan",
      },
    });
    expect(campaign.statusCode).toBe(410);
    expect(campaign.json()).toMatchObject({ code: "campaign_kickoff_moved" });
  });

  it("returns a controlled moved response for stale tree-setup clients", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding/tree-setup/kickoff",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: "stale-agent", bootstrap: "stale bootstrap" },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: "tree_setup_kickoff_moved" });
    expect(await app.db.select().from(chats).where(eq(chats.organizationId, admin.organizationId))).toHaveLength(0);
  });
});

describe("GET /me/onboarding/tree-setup-status", () => {
  const getApp = useTestApp();

  async function stampCompleted(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    admin: Awaited<ReturnType<typeof createTestAdmin>>,
    at: Date,
  ): Promise<void> {
    await app.db
      .update(members)
      .set({
        onboardingCompletedAt: at,
        onboardingSuppressedAt: at,
        onboardingSuppressedReason: "completed",
      })
      .where(eq(members.id, admin.memberId));
  }

  async function putTreeBinding(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    admin: Awaited<ReturnType<typeof createTestAdmin>>,
    updatedAt: Date,
  ): Promise<void> {
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      version: 1,
      updatedBy: admin.userId,
      updatedAt,
    });
  }

  it("does not offer tree setup recovery to non-admin members", async () => {
    const app = getApp();
    const member = await createTestAdmin(app);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, member.memberId));

    const res = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${member.organizationId}`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      needsTreeSetup: false,
      hasTreeBinding: false,
      hasTreeSetupKickoff: false,
    });
  });

  it("offers recovery to a completed admin whose org has no tree binding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await stampCompleted(app, admin, new Date("2026-06-23T10:00:00Z"));

    const res = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      needsTreeSetup: true,
      hasTreeBinding: false,
      hasTreeSetupKickoff: false,
    });
  });

  it("offers recovery when the stored Context Tree binding is not runtime-safe", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await stampCompleted(app, admin, new Date("2026-06-23T10:00:00Z"));
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { repo: "http://legacy.example/context-tree.git", branch: "bad..branch" },
      version: 1,
      updatedBy: admin.userId,
      updatedAt: new Date("2026-06-23T10:01:00Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      needsTreeSetup: true,
      hasTreeBinding: false,
      hasTreeSetupKickoff: false,
    });
  });

  it("recovers a post-completion tree binding until a tree kickoff message exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    await stampCompleted(app, admin, new Date("2026-06-23T10:00:00Z"));
    await putTreeBinding(app, admin, new Date("2026-06-23T10:01:00Z"));

    const before = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupKickoff: false,
    });

    const emptyChatId = `chat-${crypto.randomUUID()}`;
    await app.db.insert(chats).values({
      id: emptyChatId,
      organizationId: admin.organizationId,
      type: "direct",
      onboardingKickoffKey: `${admin.humanAgentUuid}:${agent.uuid}:tree-setup`,
    });

    const withEmptyChat = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(withEmptyChat.statusCode).toBe(200);
    expect(withEmptyChat.json()).toMatchObject({
      needsTreeSetup: true,
      hasTreeSetupKickoff: false,
    });

    await app.db.insert(messages).values({
      id: `msg-${crypto.randomUUID()}`,
      chatId: emptyChatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "Seed the tree.",
      source: "api",
      metadata: { mentions: [agent.uuid], addressedAgentIds: [agent.uuid] },
    });

    const after = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      needsTreeSetup: false,
      hasTreeBinding: true,
      hasTreeSetupKickoff: true,
    });
  });

  it("treats legacy kind-scoped tree kickoff messages as completed tree setup", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    await stampCompleted(app, admin, new Date("2026-06-23T10:00:00Z"));
    await putTreeBinding(app, admin, new Date("2026-06-23T10:01:00Z"));

    const legacyChatId = `chat-${crypto.randomUUID()}`;
    await app.db.insert(chats).values({
      id: legacyChatId,
      organizationId: admin.organizationId,
      type: "direct",
      onboardingKickoffKey: `${admin.humanAgentUuid}:${agent.uuid}:tree`,
    });
    await app.db.insert(messages).values({
      id: `msg-${crypto.randomUUID()}`,
      chatId: legacyChatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "Seed the legacy tree.",
      source: "api",
      metadata: { systemSender: "first_tree_onboarding" },
    });

    const res = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      needsTreeSetup: false,
      hasTreeBinding: true,
      hasTreeSetupKickoff: true,
    });
  });

  it("returns the same org-level recovery status for admins with different completion times", async () => {
    const app = getApp();
    const firstAdmin = await createTestAdmin(app);
    const laterAdmin = await createTestAdmin(app);
    expect(laterAdmin.organizationId).toBe(firstAdmin.organizationId);

    await stampCompleted(app, firstAdmin, new Date("2026-06-23T10:00:00Z"));
    await stampCompleted(app, laterAdmin, new Date("2026-06-23T11:00:00Z"));
    await putTreeBinding(app, firstAdmin, new Date("2026-06-23T10:30:00Z"));

    const first = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${firstAdmin.organizationId}`,
      headers: { authorization: `Bearer ${firstAdmin.accessToken}` },
    });
    const later = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${firstAdmin.organizationId}`,
      headers: { authorization: `Bearer ${laterAdmin.accessToken}` },
    });

    expect(first.statusCode).toBe(200);
    expect(later.statusCode).toBe(200);
    expect(first.json()).toEqual({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupKickoff: false,
    });
    expect(later.json()).toEqual(first.json());
  });

  it("keeps org-level recovery stable when the earliest completed admin is no longer active admin", async () => {
    const app = getApp();
    const firstAdmin = await createTestAdmin(app);
    const laterAdmin = await createTestAdmin(app);
    expect(laterAdmin.organizationId).toBe(firstAdmin.organizationId);

    await stampCompleted(app, firstAdmin, new Date("2026-06-23T10:00:00Z"));
    await stampCompleted(app, laterAdmin, new Date("2026-06-23T11:00:00Z"));
    await putTreeBinding(app, firstAdmin, new Date("2026-06-23T10:30:00Z"));
    await app.db.update(members).set({ role: "member", status: "left" }).where(eq(members.id, firstAdmin.memberId));

    const res = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${firstAdmin.organizationId}`,
      headers: { authorization: `Bearer ${laterAdmin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupKickoff: false,
    });
  });

  it("does not offer recovery for an older adopted binding with no onboarding tree chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await putTreeBinding(app, admin, new Date("2026-06-23T09:00:00Z"));
    await stampCompleted(app, admin, new Date("2026-06-23T10:00:00Z"));

    const res = await app.inject({
      method: "GET",
      url: `${TREE_STATUS_URL}?organizationId=${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      needsTreeSetup: false,
      hasTreeBinding: true,
      hasTreeSetupKickoff: false,
    });
  });
});
