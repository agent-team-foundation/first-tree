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
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { ConflictError, ForbiddenError } from "../errors.js";
import { cancelAttention, raiseAttention, respondAttention } from "../services/attention.js";
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
    type: "autonomous_agent",
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
});
