import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { FIRST_TREE_HUB_ATTR, withSpan } from "../observability/index.js";
import { buildClientMessagePayloadsForInbox } from "./message-dispatcher.js";

const DEFAULT_INBOX_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RETRY_COUNT = 3;

export async function pollInbox(db: Database, inboxId: string, limit: number) {
  return withSpan("inbox.deliver", { "inbox.id": inboxId, "inbox.poll.limit": limit }, () =>
    pollInboxInner(db, inboxId, limit),
  );
}

async function pollInboxInner(db: Database, inboxId: string, limit: number) {
  // Use raw SQL for SELECT ... FOR UPDATE SKIP LOCKED (not supported by Drizzle query builder)
  const result = await db.transaction(async (tx) => {
    // 1. Claim pending entries with SKIP LOCKED
    const claimed = await tx.execute<{
      id: number;
      inbox_id: string;
      message_id: string;
      chat_id: string | null;
      status: string;
      retry_count: number;
      created_at: string;
      delivered_at: string | null;
      acked_at: string | null;
    }>(sql`
      UPDATE inbox_entries
      SET status = 'delivered', delivered_at = NOW()
      WHERE id IN (
        SELECT id FROM inbox_entries
        WHERE inbox_id = ${inboxId} AND status = 'pending'
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    if (claimed.length === 0) {
      return [];
    }

    // 2. Fetch associated messages via Drizzle query builder
    const messageIds = claimed.map((e) => e.message_id);
    const msgs = await tx.select().from(messages).where(inArray(messages.id, messageIds));

    const msgMap = new Map(msgs.map((m) => [m.id, m]));

    // 3. Build wire payloads via the single dispatcher (Step 3): every
    // outbound client message must carry the current agent_configs.version
    // so the client can refresh config before delivering to the runtime.
    //
    // Payloads are keyed by (entryId) because replyTo routing can deliver the
    // same message_id to the same recipient twice under different entry
    // chatIds — each copy needs its own recipientMode lookup.
    const payloads = await buildClientMessagePayloadsForInbox(
      tx,
      inboxId,
      claimed.map((entry) => {
        const msg = msgMap.get(entry.message_id);
        if (!msg) throw new Error(`Unexpected: message ${entry.message_id} not found`);
        return {
          entryChatId: entry.chat_id,
          message: {
            id: msg.id,
            chatId: msg.chatId,
            senderId: msg.senderId,
            format: msg.format,
            content: msg.content,
            metadata: msg.metadata,
            replyToInbox: msg.replyToInbox,
            replyToChat: msg.replyToChat,
            inReplyTo: msg.inReplyTo,
            source: msg.source,
            createdAt: msg.createdAt.toISOString(),
          },
        };
      }),
    );

    return claimed.map((entry, idx) => {
      const payload = payloads[idx];
      if (!payload) throw new Error(`Unexpected: payload for entry ${entry.id} not built`);
      return {
        id: entry.id,
        inboxId: entry.inbox_id,
        messageId: entry.message_id,
        chatId: entry.chat_id,
        status: entry.status,
        retryCount: entry.retry_count,
        createdAt: entry.created_at,
        deliveredAt: entry.delivered_at ?? null,
        ackedAt: entry.acked_at ?? null,
        message: payload,
      };
    });
  });

  return result;
}

export async function ackEntry(db: Database, entryId: number, inboxId: string) {
  return withSpan(
    "inbox.ack",
    { [FIRST_TREE_HUB_ATTR.INBOX_ENTRY_ID]: String(entryId), "inbox.id": inboxId },
    async () => {
      const [entry] = await db
        .update(inboxEntries)
        .set({ status: "acked", ackedAt: new Date() })
        .where(
          and(eq(inboxEntries.id, entryId), eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.status, "delivered")),
        )
        .returning();

      if (!entry) {
        throw new NotFoundError("Inbox entry not found or not in delivered status");
      }

      return entry;
    },
  );
}

export async function renewEntry(db: Database, entryId: number, inboxId: string) {
  const [entry] = await db
    .update(inboxEntries)
    .set({ deliveredAt: new Date() })
    .where(and(eq(inboxEntries.id, entryId), eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.status, "delivered")))
    .returning();

  if (!entry) {
    throw new NotFoundError("Inbox entry not found or not in delivered status");
  }

  return entry;
}

export async function resetTimedOutEntries(
  db: Database,
  timeoutSeconds = DEFAULT_INBOX_TIMEOUT_SECONDS,
  maxRetries = DEFAULT_MAX_RETRY_COUNT,
): Promise<{ reset: number; failed: number }> {
  // Reset entries that have timed out but haven't exceeded max retries
  const resetResult = await db.execute<{ id: number }>(sql`
    UPDATE inbox_entries SET status = 'pending', retry_count = retry_count + 1
    WHERE status = 'delivered'
      AND delivered_at < NOW() - make_interval(secs => ${timeoutSeconds})
      AND retry_count < ${maxRetries}
    RETURNING id
  `);

  // Mark entries that have exceeded max retries as failed
  const failedResult = await db.execute<{ id: number }>(sql`
    UPDATE inbox_entries SET status = 'failed'
    WHERE status = 'delivered'
      AND delivered_at < NOW() - make_interval(secs => ${timeoutSeconds})
      AND retry_count >= ${maxRetries}
    RETURNING id
  `);

  return { reset: resetResult.length, failed: failedResult.length };
}

export async function assertInboxOwner(inboxId: string, agentInboxId: string): Promise<void> {
  if (inboxId !== agentInboxId) {
    throw new ForbiddenError("Cannot access another agent's inbox");
  }
}
