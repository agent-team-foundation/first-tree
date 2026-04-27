import type { PrecedingMessage } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { FIRST_TREE_HUB_ATTR, withSpan } from "../observability/index.js";
import { buildClientMessagePayloadsForInbox } from "./message-dispatcher.js";

/** Structurally-typed DB so both `Database` and transaction clients work. */
type TxLike = Pick<PostgresJsDatabase<Record<string, never>>, "execute">;

const DEFAULT_INBOX_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RETRY_COUNT = 3;

/**
 * Caps for the silent-context replay attached to an active delivery (proposal
 * §1). The window keeps stale chatter out of the prompt; the cap protects
 * against runaway batches if a chat is very chatty between two mentions of
 * the same agent. Older / overflow silent rows are still bulk-acked so they
 * don't accumulate forever.
 *
 * Exported (test-only) so the cap-overflow test doesn't have to spam 50+
 * silent messages — it pins the invariant by reading the constant.
 */
export const PRECEDING_CONTEXT_MAX_ENTRIES = 50;
export const PRECEDING_CONTEXT_WINDOW_SECONDS = 24 * 60 * 60;

export async function pollInbox(db: Database, inboxId: string, limit: number) {
  return withSpan("inbox.deliver", { "inbox.id": inboxId, "inbox.poll.limit": limit }, () =>
    pollInboxInner(db, inboxId, limit),
  );
}

async function pollInboxInner(db: Database, inboxId: string, limit: number) {
  // Use raw SQL for SELECT ... FOR UPDATE SKIP LOCKED (not supported by Drizzle query builder)
  const result = await db.transaction(async (tx) => {
    // 1. Claim pending NOTIFY=true entries (the active triggers). Silent rows
    //    (notify=false) are intentionally excluded — they piggy-back on the
    //    next active delivery in their chat as preceding context (proposal §1).
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
        WHERE inbox_id = ${inboxId} AND status = 'pending' AND notify = true
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    if (claimed.length === 0) {
      return [];
    }

    // PostgreSQL's UPDATE...RETURNING does not guarantee row order, so we sort
    // by created_at (ascending) before assembling the response. Downstream
    // consumers — and silent-context bundling in particular — depend on
    // chronological order to split context windows correctly.
    claimed.sort((a, b) => a.created_at.localeCompare(b.created_at));

    // 2. For each claimed trigger, gather silent context and bulk-ack the
    //    silent rows so they aren't replayed on the next poll. Triggers are
    //    grouped by chatId so multiple triggers in the same chat split the
    //    silent timeline into "what happened before each one" instead of
    //    duplicating context.
    const precedingByEntryId = await collectPrecedingContext(tx, inboxId, claimed);

    // 3. Fetch the trigger messages.
    const messageIds = claimed.map((e) => e.message_id);
    const msgs = await tx.select().from(messages).where(inArray(messages.id, messageIds));

    const msgMap = new Map(msgs.map((m) => [m.id, m]));

    // 4. Build wire payloads via the single dispatcher (Step 3): every
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
          precedingMessages: precedingByEntryId.get(entry.id) ?? [],
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

/**
 * Per claimed trigger: SELECT silent (notify=false) pending rows in the same
 * chat that occurred between the previous trigger in this batch (or beginning
 * of time) and this trigger, capped by `PRECEDING_CONTEXT_MAX_ENTRIES` and
 * `PRECEDING_CONTEXT_WINDOW_SECONDS`. Returned messages are oldest-first.
 *
 * Side effect: bulk-ack ALL silent pending rows in each chat with
 * created_at < latest_trigger.created_at — including ones that fell outside
 * the window/cap. Otherwise stale silent rows would accumulate and re-load
 * on every poll.
 */
async function collectPrecedingContext(
  tx: TxLike,
  inboxId: string,
  triggers: Array<{ id: number; chat_id: string | null; created_at: string }>,
): Promise<Map<number, PrecedingMessage[]>> {
  const result = new Map<number, PrecedingMessage[]>();

  // Group triggers by chatId so we can split the silent timeline per chat.
  const byChat = new Map<string, typeof triggers>();
  for (const t of triggers) {
    if (t.chat_id === null) continue; // replyTo cross-chat entries with no chat_id can't have context
    const list = byChat.get(t.chat_id) ?? [];
    list.push(t);
    byChat.set(t.chat_id, list);
  }

  for (const [chatId, chatTriggers] of byChat) {
    chatTriggers.sort((a, b) => a.created_at.localeCompare(b.created_at));

    // For each trigger, fetch silent context strictly before it (and after
    // the previous trigger in this batch). Window: 24h before the trigger.
    //
    // Order matters: when there are MORE than `PRECEDING_CONTEXT_MAX_ENTRIES`
    // candidates, we want to keep the rows CLOSEST to the trigger (most
    // contextually relevant) and drop the oldest. So select DESC + LIMIT,
    // then reverse in JS to get chronological prompt-ready output. Selecting
    // ASC + LIMIT would drop the recent rows — and the bulk-ack below would
    // mark them acked anyway, so the agent would silently lose the messages
    // that mattered most.
    //
    // Concurrency: `FOR UPDATE OF ie SKIP LOCKED` prevents two parallel polls
    // on the same inbox from bundling the same silent row twice. Without it,
    // poll A picking trigger T1 and poll B picking T2 (T2 > T1) would both
    // include silent rows < T1 in their preceding context. With SKIP LOCKED,
    // the second poll skips the rows the first has reserved.
    let prevCreatedAt: string | null = null;
    for (const trigger of chatTriggers) {
      const rows = await tx.execute<{
        id: number;
        message_id: string;
        sender_id: string;
        format: string;
        content: unknown;
        metadata: unknown;
        created_at: string;
      }>(sql`
        SELECT ie.id, m.id AS message_id, m.sender_id, m.format, m.content, m.metadata,
               m.created_at
        FROM inbox_entries ie
        JOIN messages m ON m.id = ie.message_id
        WHERE ie.inbox_id = ${inboxId}
          AND ie.chat_id = ${chatId}
          AND ie.status = 'pending'
          AND ie.notify = false
          AND ie.created_at < ${trigger.created_at}
          ${prevCreatedAt === null ? sql`` : sql`AND ie.created_at > ${prevCreatedAt}`}
          AND ie.created_at > NOW() - make_interval(secs => ${PRECEDING_CONTEXT_WINDOW_SECONDS})
        ORDER BY ie.created_at DESC
        LIMIT ${PRECEDING_CONTEXT_MAX_ENTRIES}
        FOR UPDATE OF ie SKIP LOCKED
      `);

      // Reverse so the prompt-rendered block reads oldest → newest.
      const preceding: PrecedingMessage[] = rows
        .map((r) => ({
          id: r.message_id,
          senderId: r.sender_id,
          format: r.format,
          content: r.content,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
          createdAt: r.created_at,
        }))
        .reverse();
      result.set(trigger.id, preceding);
      prevCreatedAt = trigger.created_at;
    }

    // Bulk-ack ALL silent pending rows in this chat strictly before the
    // latest trigger — covers both "included in preceding" and "dropped due
    // to cap/window". Without this the cap-overflow rows would re-attach to
    // the next trigger and grow forever.
    const latestTrigger = chatTriggers[chatTriggers.length - 1];
    if (latestTrigger) {
      await tx.execute(sql`
        UPDATE inbox_entries
        SET status = 'acked', acked_at = NOW()
        WHERE inbox_id = ${inboxId}
          AND chat_id = ${chatId}
          AND status = 'pending'
          AND notify = false
          AND created_at < ${latestTrigger.created_at}
      `);
    }
  }

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

/** Default age (30 days) past which silent rows that no notify-true delivery
 *  ever picked up are physically deleted. */
export const SILENT_ROW_GC_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Garbage-collect silent inbox rows so the table doesn't grow forever in
 * chats where a `mention_only` agent is never @mentioned.
 *
 * Two cleanup paths:
 *
 *   1. `notify=false AND status='acked'` of any age — these are fully
 *      consumed (either bundled into a previous trigger or aged out via the
 *      bulk-ack in `collectPrecedingContext`); keep them only as long as
 *      the corresponding message rows we link to. The unique constraint
 *      `(inbox_id, message_id, chat_id)` means leaving them around blocks
 *      legitimate retries with the same key.
 *
 *   2. `notify=false AND status='pending' AND created_at < NOW() - maxAge` —
 *      stale silent rows that no trigger ever caught up with. After 30
 *      days they're useless as preceding context (the @mention almost
 *      certainly already happened or the chat went dormant).
 *
 * Returns the number of rows deleted in each bucket so the background task
 * can log meaningful counts.
 */
export async function pruneStaleSilentEntries(
  db: Database,
  maxAgeSeconds = SILENT_ROW_GC_MAX_AGE_SECONDS,
): Promise<{ ackedDeleted: number; stalePendingDeleted: number }> {
  const ackedResult = await db.execute<{ id: number }>(sql`
    DELETE FROM inbox_entries
    WHERE notify = false
      AND status = 'acked'
    RETURNING id
  `);

  const staleResult = await db.execute<{ id: number }>(sql`
    DELETE FROM inbox_entries
    WHERE notify = false
      AND status = 'pending'
      AND created_at < NOW() - make_interval(secs => ${maxAgeSeconds})
    RETURNING id
  `);

  return { ackedDeleted: ackedResult.length, stalePendingDeleted: staleResult.length };
}

export async function assertInboxOwner(inboxId: string, agentInboxId: string): Promise<void> {
  if (inboxId !== agentInboxId) {
    throw new ForbiddenError("Cannot access another agent's inbox");
  }
}
