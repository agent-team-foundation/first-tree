import { randomUUID } from "node:crypto";
import { chatMetadataSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adapterAgentMappings } from "../db/schema/adapter-agent-mappings.js";
import { adapterChatMappings } from "../db/schema/adapter-chat-mappings.js";
import { adapterMessageReferences } from "../db/schema/adapter-message-references.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { resolveDefaultOrgId } from "./organization.js";
import { addChatParticipants } from "./participant-mode.js";

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
      .where(eq(agents.uuid, data.botAgentId))
      .limit(1);

    const orgId = botAgent?.organizationId ?? (await resolveDefaultOrgId(db));

    // Validate metadata against the shared discriminated union BEFORE the
    // raw INSERT. The feishu adapter is the only caller today and its shape
    // matches the `feishu` variant of `chatMetadataSchema`; the parse here
    // is the cheap defence against a future caller silently writing a
    // colliding key (e.g. another writer's `source: "github"` would crash
    // here instead of corrupting downstream readers). See design doc §4.11.
    const metadata = chatMetadataSchema.parse({
      source: data.platform,
      externalChannelId: data.externalChannelId,
    });

    await tx.insert(chats).values({
      id: chatId,
      organizationId: orgId,
      type: internalType,
      topic: data.topic ?? null,
      lifecyclePolicy: "adapter_managed",
      metadata,
    });

    // Add bot agent and sender as participants. External IM users
    // (Feishu/Slack) always map to a `human` agent on the sender side, so
    // these chats are inherently human↔agent. `addChatParticipants` derives
    // the right mode from `(chats.type, agents.type)` — for the IM adapter
    // path: human sender stays `full`; bot agent in a `direct` chat with a
    // human peer also resolves to `full` per `defaultParticipantMode`. Pre-
    // fix this site hardcoded `mode: 'full'` for every row, which would
    // silently break if an adapter ever paired two non-human agents (the
    // anti-echo invariant from migration 0029 would not apply).
    const specs =
      data.botAgentId === data.senderAgentId
        ? [{ agentId: data.botAgentId, role: "member" as const }]
        : [
            { agentId: data.botAgentId, role: "member" as const },
            { agentId: data.senderAgentId, role: "member" as const },
          ];
    await addChatParticipants(tx, chatId, specs);

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

/**
 * Ensure an agent is a speaker of a chat (no-op if already). Mode is
 * derived via the canonical entrypoint — pre-fix this hardcoded
 * `mode: 'full'`, which is wrong for non-human agents in a group chat
 * (the bug §1.1 of the Phase 1 design doc fixes). `upgradeWatcherToSpeaker`
 * promotes a pre-existing watcher row in place; chat_user_state is
 * structurally separate so read state survives untouched.
 */
async function ensureParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  const [exists] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)))
    .limit(1);

  if (exists?.accessMode === "speaker") return;
  await addChatParticipants(db, chatId, [{ agentId, role: "member" }], { upgradeWatcherToSpeaker: true });
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
