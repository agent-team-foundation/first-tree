/**
 * Unit tests for the chat auto-archive sweeper (`sweepChatArchive`). Covers
 * the two routes the sweeper owns:
 *
 *   Route A — chats with GitHub mappings: archive when every mapped entity
 *             is terminal AND `last_message_at` is older than the mapped
 *             idle threshold.
 *   Route B — chats with no GitHub mapping: archive (chat, user) pairs
 *             with no unread mentions AND `last_message_at` older than the
 *             unmapped idle threshold.
 *
 * Also asserts the shared per-user safety guards: deleted-sticky and
 * already-archived rows are never touched; sweeps are idempotent.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { attentions } from "../db/schema/attentions.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { sweepChatArchive } from "../services/chat-archive.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function seedHumanAgent(app: App, orgId: string, memberId: string): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `human-${uuid.slice(0, 8)}`,
    organizationId: orgId,
    type: "human",
    displayName: "x",
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

async function seedDelegateAgent(app: App, orgId: string, memberId: string): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `dlg-${uuid.slice(0, 8)}`,
    organizationId: orgId,
    type: "autonomous_agent",
    displayName: "d",
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

async function seedChat(app: App, orgId: string, lastMessageAt: Date | null): Promise<string> {
  const chatId = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({
    id: chatId,
    organizationId: orgId,
    type: "direct",
    lastMessageAt,
  });
  return chatId;
}

async function addHumanMember(app: App, chatId: string, agentId: string): Promise<void> {
  await app.db.insert(chatMembership).values({
    chatId,
    agentId,
    role: "member",
    accessMode: "speaker",
    source: "manual",
  });
}

async function seedAttention(
  app: App,
  chatId: string,
  agentId: string,
  targetHumanId: string,
  state: "open" | "closed" = "open",
): Promise<void> {
  await app.db.insert(attentions).values({
    id: randomUUID(),
    originAgentId: agentId,
    originChatId: chatId,
    targetHumanId,
    subject: "q",
    body: "",
    requiresResponse: true,
    state,
    metadata: {},
  });
}

async function getEngagement(app: App, chatId: string, agentId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ engagementStatus: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agentId)))
    .limit(1);
  return row?.engagementStatus ?? null;
}

const HOURS = 60 * 60;
const longAgo = () => new Date(Date.now() - 48 * HOURS * 1000);
const recent = () => new Date(Date.now() - 5 * 60 * 1000);

describe("sweepChatArchive — Route A (chats with GitHub mappings)", () => {
  const getApp = useTestApp();

  it("archives a chat when every mapped entity is terminal and idle > threshold", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#1",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive when any mapped entity is still open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    // One merged, one still open → BOOL_AND is false.
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#2",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#3",
        chatId,
        boundVia: "direct",
        entityState: "open",
      },
    ]);

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("does not archive when chat is settled but message is recent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, recent());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#4",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("preserves user-deleted state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#5",
      chatId,
      boundVia: "direct",
      entityState: "closed",
    });
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "deleted",
      unreadMentionCount: 0,
    });

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, human)).toBe("deleted");
  });

  it("archives chats whose every mapped entity is 'closed' (not just merged)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    // Both entities are 'closed' (e.g. issue closed without a fix PR + a closed-unmerged PR).
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "issue",
        entityKey: "owner/repo#9",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#10",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
    ]);

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not touch sub-chats (parent_chat_id IS NOT NULL)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const parentChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: parentChatId,
      organizationId: admin.organizationId,
      type: "direct",
      lastMessageAt: longAgo(),
    });
    // Sub-chat: same shape, but parent_chat_id set. Matches the schema's
    // historical-only scaffolding scenario.
    const subChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: subChatId,
      organizationId: admin.organizationId,
      type: "direct",
      parentChatId,
      lastMessageAt: longAgo(),
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#11",
      chatId: subChatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, subChatId, human)).toBeNull();
  });

  it("is idempotent under repeated sweeps", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#6",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const first = await sweepChatArchive(app.db);
    const second = await sweepChatArchive(app.db);

    expect(first.mappedRowsArchived).toBe(1);
    expect(second.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive any user when the chat has a pending ask-user question", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#12",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });
    // Delegate has an unanswered Attention outstanding on this chat. Even
    // though every mapped entity is terminal and the chat is idle, the
    // archive must wait — otherwise the attention disappears from the user's
    // "needs you" surface with the chat itself.
    await seedAttention(app, chatId, delegate, human, "open");

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("ignores closed attentions when deciding eligibility", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#13",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });
    // Two historic closed attentions — must not block the archive.
    await seedAttention(app, chatId, delegate, human, "closed");
    await seedAttention(app, chatId, delegate, human, "closed");

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("skips a user with unread > 0 while still archiving the other user on the same chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const h1 = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const h2 = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    // Two mapping rows on the same chat — one per (human, delegate, entity).
    // PK includes humanAgentId, so this is permitted.
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: h1,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#14",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: h2,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#14",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
    ]);
    // h1 still has unread (mention or manual mark — both surface here per
    // the semantic overload of unread_mention_count). h2 is fully read.
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: h1,
      engagementStatus: "active",
      unreadMentionCount: 3,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    // h1 keeps the explicit active row — guard short-circuits before write.
    expect(await getEngagement(app, chatId, h1)).toBe("active");
    // h2 had no prior row — sweeper materialises one in 'archived'.
    expect(await getEngagement(app, chatId, h2)).toBe("archived");
  });
});

describe("sweepChatArchive — Route B (chats with no GitHub mapping)", () => {
  const getApp = useTestApp();

  async function seedReadAcknowledgement(app: App, chatId: string, agentId: string): Promise<void> {
    await app.db.insert(chatUserState).values({
      chatId,
      agentId,
      engagementStatus: "active",
      unreadMentionCount: 0,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
  }

  it("archives a chat once it has been idle past the unmapped threshold and user has acknowledged read", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    await seedReadAcknowledgement(app, chatId, human);

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBeGreaterThanOrEqual(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive a user who has never opened the chat (last_read_at IS NULL)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    // No chat_user_state row at all — user has never opened the chat. The
    // sweeper must leave the implicit-active view alone, otherwise the user
    // returns to find the chat already in the Archived tab without ever
    // having seen it.

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("does not archive a user with unread mentions", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "active",
      unreadMentionCount: 2,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, human)).toBe("active");
  });

  it("does not archive a recently active chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, recent());
    await addHumanMember(app, chatId, human);
    await seedReadAcknowledgement(app, chatId, human);

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, human)).toBe("active");
  });

  it("does not archive chats that have GitHub mappings (Route A's responsibility)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    // Make the user a Route-B-eligible candidate so the assertion only
    // succeeds because the mapping presence excludes the chat from Route B.
    await seedReadAcknowledgement(app, chatId, human);
    // Mapping with an open entity → Route A should NOT fire either, and
    // Route B must skip this chat entirely.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#7",
      chatId,
      boundVia: "direct",
      entityState: "open",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("active");
  });

  it("ignores non-human members", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const robot = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, robot);

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, robot)).toBeNull();
  });

  it("does not archive when the chat has an open Attention outstanding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    await seedReadAcknowledgement(app, chatId, human);
    // Same carve-out as Route A: a delegate's outstanding attention keeps
    // the chat out of the Archived tab even on the long-idle no-mapping path.
    await seedAttention(app, chatId, delegate, human, "open");

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("active");
  });
});

describe("sweepChatArchive — thresholds", () => {
  const getApp = useTestApp();

  it("respects custom mappedIdleSeconds", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    // 30 minutes ago → under the default 1h, but a custom 10-minute threshold catches it.
    const chatId = await seedChat(app, admin.organizationId, new Date(Date.now() - 30 * 60 * 1000));
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#8",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const before = await sweepChatArchive(app.db);
    expect(before.mappedRowsArchived).toBe(0);

    const after = await sweepChatArchive(app.db, { mappedIdleSeconds: 10 * 60 });
    expect(after.mappedRowsArchived).toBe(1);
  });
});
