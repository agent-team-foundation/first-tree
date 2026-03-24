import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adapterAgentMappings } from "../db/schema/adapter-agent-mappings.js";
import { adapterChatMappings } from "../db/schema/adapter-chat-mappings.js";
import { adapterMessageReferences } from "../db/schema/adapter-message-references.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";

// ── Event deduplication ─────────────────────────────────────────────

/**
 * Attempt to claim an event for processing.
 * Returns true if this is the first time the event is seen, false if duplicate.
 */
export async function claimEvent(db: Database, eventId: string, platform: string): Promise<boolean> {
  const result = await db.execute<{ event_id: string }>(
    sql`INSERT INTO processed_events (event_id, platform) VALUES (${eventId}, ${platform}) ON CONFLICT DO NOTHING RETURNING event_id`,
  );
  return result.length > 0;
}

/**
 * Remove a claimed event so it can be retried on next delivery.
 * Called when processing fails after claimEvent() succeeded.
 */
export async function unclaimEvent(db: Database, eventId: string, platform: string): Promise<void> {
  await db.execute(sql`DELETE FROM processed_events WHERE event_id = ${eventId} AND platform = ${platform}`);
}

// ── Agent mapping ───────────────────────────────────────────────────

/** Look up the internal agent ID for an external user. */
export async function findAgentByExternalUser(
  db: Database,
  platform: string,
  externalUserId: string,
): Promise<{ agentId: string; displayName: string | null } | null> {
  const [row] = await db
    .select({ agentId: adapterAgentMappings.agentId, displayName: adapterAgentMappings.displayName })
    .from(adapterAgentMappings)
    .where(and(eq(adapterAgentMappings.platform, platform), eq(adapterAgentMappings.externalUserId, externalUserId)))
    .limit(1);
  return row ?? null;
}

/** Look up the external user ID for an internal agent. */
export async function findExternalUserByAgent(
  db: Database,
  platform: string,
  agentId: string,
): Promise<{ externalUserId: string } | null> {
  const [row] = await db
    .select({ externalUserId: adapterAgentMappings.externalUserId })
    .from(adapterAgentMappings)
    .where(and(eq(adapterAgentMappings.platform, platform), eq(adapterAgentMappings.agentId, agentId)))
    .limit(1);
  return row ?? null;
}

/** Create an agent mapping. */
export async function createAgentMapping(
  db: Database,
  data: {
    platform: string;
    externalUserId: string;
    agentId: string;
    boundVia?: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<typeof adapterAgentMappings.$inferSelect> {
  const [row] = await db
    .insert(adapterAgentMappings)
    .values({
      platform: data.platform,
      externalUserId: data.externalUserId,
      agentId: data.agentId,
      boundVia: data.boundVia ?? null,
      displayName: data.displayName ?? null,
      metadata: data.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning();

  // If conflict, fetch the existing row
  if (!row) {
    const [existing] = await db
      .select()
      .from(adapterAgentMappings)
      .where(
        and(
          eq(adapterAgentMappings.platform, data.platform),
          eq(adapterAgentMappings.externalUserId, data.externalUserId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Unexpected: concurrent insert failed and row not found");
    return existing;
  }
  return row;
}

// ── Chat mapping ────────────────────────────────────────────────────

/** Look up the internal chat ID for an external channel. */
export async function findChatByExternalChannel(
  db: Database,
  platform: string,
  externalChannelId: string,
  threadId?: string | null,
): Promise<{ chatId: string } | null> {
  const conditions = [
    eq(adapterChatMappings.platform, platform),
    eq(adapterChatMappings.externalChannelId, externalChannelId),
  ];

  // Match COALESCE(thread_id, '') semantics
  if (threadId) {
    conditions.push(eq(adapterChatMappings.threadId, threadId));
  } else {
    conditions.push(sql`${adapterChatMappings.threadId} IS NULL`);
  }

  const [row] = await db
    .select({ chatId: adapterChatMappings.chatId })
    .from(adapterChatMappings)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

/** Look up the external channel for an internal chat. */
export async function findExternalChannelByChat(
  db: Database,
  platform: string,
  chatId: string,
): Promise<{ externalChannelId: string; threadId: string | null } | null> {
  const [row] = await db
    .select({
      externalChannelId: adapterChatMappings.externalChannelId,
      threadId: adapterChatMappings.threadId,
    })
    .from(adapterChatMappings)
    .where(and(eq(adapterChatMappings.platform, platform), eq(adapterChatMappings.chatId, chatId)))
    .limit(1);
  return row ?? null;
}

/**
 * Find or create an internal Chat for an external channel.
 * Ensures the bot's bound agent and the sender are participants.
 */
export async function findOrCreateChatForChannel(
  db: Database,
  data: {
    platform: string;
    externalChannelId: string;
    threadId?: string | null;
    chatType: string;
    topic?: string;
    /** The agent bound to the bot via adapter_configs.agentId */
    botAgentId: string;
    senderAgentId: string;
  },
): Promise<string> {
  // Check existing mapping
  const existing = await findChatByExternalChannel(db, data.platform, data.externalChannelId, data.threadId);
  if (existing) {
    // Ensure both bot agent and sender are participants
    await ensureParticipant(db, existing.chatId, data.botAgentId);
    await ensureParticipant(db, existing.chatId, data.senderAgentId);
    return existing.chatId;
  }

  // Create new chat + mapping in transaction
  const chatId = randomUUID();
  const internalType = data.chatType === "p2p" ? "direct" : "group";

  return db.transaction(async (tx) => {
    // Get bot agent's org
    const [botAgent] = await tx
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.id, data.botAgentId))
      .limit(1);

    const orgId = botAgent?.organizationId ?? "default";

    await tx.insert(chats).values({
      id: chatId,
      organizationId: orgId,
      type: internalType,
      topic: data.topic ?? null,
      lifecyclePolicy: "adapter_managed",
      metadata: { source: data.platform, externalChannelId: data.externalChannelId },
    });

    // Add bot agent and sender as participants
    const participants =
      data.botAgentId === data.senderAgentId
        ? [{ chatId, agentId: data.botAgentId, role: "member" as const }]
        : [
            { chatId, agentId: data.botAgentId, role: "member" as const },
            { chatId, agentId: data.senderAgentId, role: "member" as const },
          ];
    await tx.insert(chatParticipants).values(participants);

    // Create mapping
    await tx.insert(adapterChatMappings).values({
      platform: data.platform,
      externalChannelId: data.externalChannelId,
      chatId,
      threadId: data.threadId ?? null,
      metadata: {},
    });

    return chatId;
  });
}

/** Ensure an agent is a participant of a chat (no-op if already). */
async function ensureParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  const [exists] = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, agentId)))
    .limit(1);

  if (!exists) {
    await db.insert(chatParticipants).values({ chatId, agentId, role: "member" }).onConflictDoNothing();
  }
}

// ── Message references ──────────────────────────────────────────────

/** Store a cross-reference between internal and external message. */
export async function createMessageReference(
  db: Database,
  data: {
    messageId: string;
    platform: string;
    externalMessageId: string;
    externalChannelId: string;
  },
): Promise<void> {
  await db
    .insert(adapterMessageReferences)
    .values({
      messageId: data.messageId,
      platform: data.platform,
      externalMessageId: data.externalMessageId,
      externalChannelId: data.externalChannelId,
    })
    .onConflictDoNothing();
}

/** Find internal message ID from external message reference. */
export async function findMessageByExternalId(
  db: Database,
  platform: string,
  externalMessageId: string,
): Promise<{ messageId: string } | null> {
  const [row] = await db
    .select({ messageId: adapterMessageReferences.messageId })
    .from(adapterMessageReferences)
    .where(
      and(
        eq(adapterMessageReferences.platform, platform),
        eq(adapterMessageReferences.externalMessageId, externalMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Find external message ID from internal message reference. */
export async function findExternalMessageByInternalId(
  db: Database,
  platform: string,
  messageId: string,
): Promise<{ externalMessageId: string; externalChannelId: string } | null> {
  const [row] = await db
    .select({
      externalMessageId: adapterMessageReferences.externalMessageId,
      externalChannelId: adapterMessageReferences.externalChannelId,
    })
    .from(adapterMessageReferences)
    .where(and(eq(adapterMessageReferences.platform, platform), eq(adapterMessageReferences.messageId, messageId)))
    .limit(1);
  return row ?? null;
}
