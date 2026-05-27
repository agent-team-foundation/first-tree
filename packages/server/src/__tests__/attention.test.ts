/**
 * Service-layer tests for the NHA M1 末 (Need Human Attention) primitive.
 * Exercises the service directly (not the HTTP layer) so the invariants
 * documented in `packages/shared/src/schemas/attention.ts` are pinned at
 * the cheapest layer:
 *
 *   - raise happy path → record returned
 *   - raise with target NOT in chat → 409 (ConflictError) + invite hint
 *   - respond by non-target → 403 (ForbiddenError)
 *   - cancel by non-origin → 403 (ForbiddenError)
 *   - requires_response=false → state="closed" + closedAt set on creation
 *
 * Tests run against the testcontainer Postgres provisioned by
 * `useTestApp` / `createTestApp` — no HTTP injection needed.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { ConflictError, ForbiddenError } from "../errors.js";
import { cancelAttention, listAttentions, raiseAttention, respondAttention } from "../services/attention.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function seedHumanAgent(app: App, orgId: string, memberId: string): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `human-${uuid.slice(0, 8)}`,
    organizationId: orgId,
    type: "human",
    displayName: "h",
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

async function seedAutonomousAgent(app: App, orgId: string, memberId: string): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `bot-${uuid.slice(0, 8)}`,
    organizationId: orgId,
    type: "agent",
    displayName: "b",
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

async function seedChat(app: App, orgId: string): Promise<string> {
  const chatId = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({
    id: chatId,
    organizationId: orgId,
    type: "group",
  });
  return chatId;
}

async function addSpeaker(
  app: App,
  chatId: string,
  agentId: string,
  role: "owner" | "member" = "member",
): Promise<void> {
  await app.db.insert(chatMembership).values({
    chatId,
    agentId,
    role,
    accessMode: "speaker",
    source: "manual",
  });
}

describe("attention service — invariants", () => {
  const getApp = useTestApp();

  it("raise happy path: returns a wire record with state=open when requiresResponse=true", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const bot = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId);
    await addSpeaker(app, chatId, human);
    await addSpeaker(app, chatId, bot, "owner");

    const created = await raiseAttention(app.db, bot, {
      chatId,
      target: human,
      subject: "Please review",
      body: "",
      requiresResponse: true,
      metadata: {},
    });

    expect(created.originAgentId).toBe(bot);
    expect(created.targetHumanId).toBe(human);
    expect(created.originChatId).toBe(chatId);
    expect(created.state).toBe("open");
    expect(created.closedAt).toBeNull();
    expect(created.requiresResponse).toBe(true);
  });

  it("raise with target NOT in chat → ConflictError with chat-invite hint", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const bot = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId);
    // Only bot is in the chat; the target human is NOT.
    await addSpeaker(app, chatId, bot, "owner");

    await expect(
      raiseAttention(app.db, bot, {
        chatId,
        target: human,
        subject: "ping",
        body: "",
        requiresResponse: true,
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires_response=false closes the row on creation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const bot = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId);
    await addSpeaker(app, chatId, human);
    await addSpeaker(app, chatId, bot, "owner");

    const created = await raiseAttention(app.db, bot, {
      chatId,
      target: human,
      subject: "FYI",
      body: "",
      requiresResponse: false,
      metadata: {},
    });

    expect(created.state).toBe("closed");
    expect(created.closedAt).not.toBeNull();
    expect(created.requiresResponse).toBe(false);
  });

  it("respond by non-target → ForbiddenError", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const bystanderHuman = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const bot = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId);
    await addSpeaker(app, chatId, human);
    await addSpeaker(app, chatId, bystanderHuman);
    await addSpeaker(app, chatId, bot, "owner");

    const created = await raiseAttention(app.db, bot, {
      chatId,
      target: human,
      subject: "needs you",
      body: "",
      requiresResponse: true,
      metadata: {},
    });

    await expect(
      respondAttention(app.db, bystanderHuman, created.id, { text: "I'm not the target" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("respond echoes the answer as a chat message with the human as sender", async () => {
    // Per proposal §5.1 asks stay out of the chat scroll; the answer
    // flows back into chat so co-speakers see the decision inline.
    // Sender of the echo message is the target human (not the origin
    // agent) so the thread reads "alice answered: deploy" naturally.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const bot = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId);
    await addSpeaker(app, chatId, human);
    await addSpeaker(app, chatId, bot, "owner");

    const created = await raiseAttention(app.db, bot, {
      chatId,
      target: human,
      subject: "deploy approval",
      body: "",
      requiresResponse: true,
      metadata: {},
    });

    // Sanity: raising the ask does NOT post a chat message — the chat
    // is silent until the human replies.
    const preEcho = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(preEcho.length).toBe(0);

    const closed = await respondAttention(app.db, human, created.id, { text: "deploy — diff looks clean" });
    expect(closed.state).toBe("closed");
    // The canonical answer on the attention row is the raw response text
    // — the `@<origin>` echo prefix is a chat-rendering concern, not part
    // of the stored answer.
    expect(closed.response).toBe("deploy — diff looks clean");

    const [botRow] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.uuid, bot));
    expect(botRow?.name).toBeTruthy();
    const botName = botRow?.name ?? "";

    const postEcho = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(postEcho.length).toBe(1);
    const echo = postEcho[0];
    expect(echo).toBeDefined();
    if (!echo) return;
    expect(echo.senderId).toBe(human);
    // Echo content is prefixed with `@<originAgent>` so readers of the
    // chat thread see who the reply is directed at, and so sendMessage's
    // `@<name>` extraction wakes the asking agent.
    expect(echo.content).toBe(`@${botName} deploy — diff looks clean`);
    expect(echo.format).toBe("text");
    // The echo carries the linkage back to the originating attention so
    // exports / search / rendering can opt in to a "this was an answer"
    // visual without inferring from heuristics.
    const echoMetadata = echo.metadata as Record<string, unknown>;
    expect(echoMetadata.attentionResponseFor).toBe(created.id);
    // The `@<originAgent>` prefix must resolve to the asker's uuid via
    // content extraction — this is the wake-up routing that lets the
    // asking agent resume after the human responds.
    const mentions = echoMetadata.mentions;
    expect(Array.isArray(mentions)).toBe(true);
    expect(mentions as string[]).toContain(bot);
  });

  it("cancel by non-origin → ForbiddenError", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const botA = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const botB = await seedAutonomousAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId);
    await addSpeaker(app, chatId, human);
    await addSpeaker(app, chatId, botA, "owner");
    await addSpeaker(app, chatId, botB);

    const created = await raiseAttention(app.db, botA, {
      chatId,
      target: human,
      subject: "needs you",
      body: "",
      requiresResponse: true,
      metadata: {},
    });

    await expect(cancelAttention(app.db, botB, created.id, "not mine")).rejects.toBeInstanceOf(ForbiddenError);
  });

  // Multi-user group-chat visibility (strict): a co-speaker who is neither
  // the target nor the manager-of-origin must NOT see the ask. Both arms
  // of the "relevant to me" union (target=me, origin=my-managed-agent) are
  // exercised against the same chat.
  it("listAttentions strict scoping for humans in multi-user group chats", async () => {
    const app = getApp();
    // Use two real admins so each human-agent has a `members` row — the
    // strict scope joins `agents.manager_id → members.id → members.agent_id`
    // and would otherwise fall back to target-only for both callers.
    const adminA = await createTestAdmin(app);
    const adminB = await createTestAdmin(app, { username: `peer-${randomUUID().slice(0, 8)}` });
    const alice = adminA.humanAgentUuid;
    const bob = adminB.humanAgentUuid;

    // Two bots in adminA's org — deploy-bot managed by alice, monitor-bot
    // managed by bob (cross-org manager ref is fine for the lookup).
    const deployBot = await seedAutonomousAgent(app, adminA.organizationId, adminA.memberId);
    const monitorBot = await seedAutonomousAgent(app, adminA.organizationId, adminB.memberId);
    const chatId = await seedChat(app, adminA.organizationId);
    await addSpeaker(app, chatId, alice);
    await addSpeaker(app, chatId, bob);
    await addSpeaker(app, chatId, deployBot, "owner");
    await addSpeaker(app, chatId, monitorBot);

    // alice's bot asks alice → both relevance arms (target + origin) point at alice
    const askAliceMine = await raiseAttention(app.db, deployBot, {
      chatId,
      target: alice,
      subject: "deploy approval",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    // bob's bot asks bob → bob's concern, irrelevant to alice
    const askBobTheirs = await raiseAttention(app.db, monitorBot, {
      chatId,
      target: bob,
      subject: "monitor threshold",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    // alice's bot asks bob → alice owns the origin, but the ask itself
    // targets bob. Strict policy: visible to BOTH alice (managed origin)
    // and bob (target).
    const askBobMineOrigin = await raiseAttention(app.db, deployBot, {
      chatId,
      target: bob,
      subject: "needs bob's call",
      body: "",
      requiresResponse: true,
      metadata: {},
    });

    const aliceVisible = await listAttentions(
      app.db,
      { agentId: alice, isHuman: true },
      { chat: chatId, state: "open", limit: 50 },
    );
    const aliceIds = aliceVisible.map((a) => a.id).sort();
    expect(aliceIds).toEqual([askAliceMine.id, askBobMineOrigin.id].sort());

    const bobVisible = await listAttentions(
      app.db,
      { agentId: bob, isHuman: true },
      { chat: chatId, state: "open", limit: 50 },
    );
    const bobIds = bobVisible.map((a) => a.id).sort();
    expect(bobIds).toEqual([askBobTheirs.id, askBobMineOrigin.id].sort());

    // The ask only relevant to one of them never shows up for the other.
    expect(aliceIds).not.toContain(askBobTheirs.id);
    expect(bobIds).not.toContain(askAliceMine.id);
  });
});
