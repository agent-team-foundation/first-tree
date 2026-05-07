import type { InboxEntryWithMessage, PrecedingMessage } from "@agent-team-foundation/first-tree-hub-shared";
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { FIRST_TREE_HUB_ATTR, withSpan } from "../observability/index.js";
import { buildClientMessagePayloadsForInbox } from "./message-dispatcher.js";

/** Claimed `inbox_entries` row, typed via Drizzle `$inferSelect` so column-mode
 *  conversions (bigserial → number, timestamp → Date) flow through. */
type ClaimedEntry = typeof inboxEntries.$inferSelect;

/** Structurally-typed DB so both `Database` and transaction clients work. */
type TxLike = Pick<PostgresJsDatabase<Record<string, never>>, "select" | "update" | "delete">;

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
  return db.transaction(async (tx) => {
    // Claim pending notify=true entries (active triggers). Silent rows
    // (notify=false) are intentionally excluded — they piggy-back on the
    // next active delivery in their chat as preceding context (proposal §1).
    //
    // The subquery's `FOR UPDATE SKIP LOCKED` is what keeps concurrent
    // pollers / WS-push handlers from claiming the same row twice. The outer
    // UPDATE then flips status to 'delivered' on whichever rows the subquery
    // successfully locked — canonical PG SKIP-LOCKED queue idiom.
    const targetIds = tx
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.status, "pending"), eq(inboxEntries.notify, true)))
      .orderBy(asc(inboxEntries.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = await tx
      .update(inboxEntries)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(inArray(inboxEntries.id, targetIds))
      .returning();

    return bundleDeliveryWithSilentContext(tx, inboxId, claimed);
  });
}

/**
 * Shared payload assembler for already-claimed `inbox_entries` rows.
 *
 * Both the HTTP poll path (`pollInbox`) and the WS push path
 * (`claimAndBuildForPush`) call this with rows they have just `UPDATE`d to
 * `status='delivered'`. Keeping the silent-context bundling in one place is
 * the only way to keep the two paths from drifting (proposal
 * hub-inbox-ws-data-plane §3.2 risk #1).
 *
 * Steps:
 *   1. Sort by `createdAt` ASC (PG `RETURNING` does not guarantee order).
 *   2. For each trigger, collect silent context & bulk-ack stale silent rows.
 *   3. Fetch the trigger messages.
 *   4. Build wire payloads via the single dispatcher.
 *
 * Returns `[]` if `claimed` is empty.
 */
export async function bundleDeliveryWithSilentContext(
  tx: TxLike,
  inboxId: string,
  claimed: ClaimedEntry[],
): Promise<InboxEntryWithMessage[]> {
  if (claimed.length === 0) return [];

  // PostgreSQL's UPDATE...RETURNING does not guarantee row order, so we sort
  // by createdAt (ascending) before assembling the response. Downstream
  // consumers — and silent-context bundling in particular — depend on
  // chronological order to split context windows correctly.
  claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const precedingByEntryId = await collectPrecedingContext(tx, inboxId, claimed);

  const messageIds = claimed.map((e) => e.messageId);
  const msgs = await tx.select().from(messages).where(inArray(messages.id, messageIds));
  const msgMap = new Map(msgs.map((m) => [m.id, m]));

  // Step 3 (M1 §10): every outbound client message must carry the current
  // agent_configs.version so the client can refresh config before delivering
  // to the runtime. Payloads are keyed by (entryId) because replyTo routing
  // can deliver the same message_id twice under different entry chatIds —
  // each copy needs its own recipientMode lookup.
  const payloads = await buildClientMessagePayloadsForInbox(
    tx,
    inboxId,
    claimed.map((entry) => {
      const msg = msgMap.get(entry.messageId);
      if (!msg) throw new Error(`Unexpected: message ${entry.messageId} not found`);
      return {
        entryChatId: entry.chatId,
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
      inboxId: entry.inboxId,
      messageId: entry.messageId,
      chatId: entry.chatId,
      status: entry.status,
      retryCount: entry.retryCount,
      createdAt: entry.createdAt.toISOString(),
      deliveredAt: entry.deliveredAt?.toISOString() ?? null,
      ackedAt: entry.ackedAt?.toISOString() ?? null,
      message: payload,
    };
  });
}

/**
 * Realistic upper bound on rows a single NOTIFY references. The unique
 * constraint `(inbox_id, message_id, chat_id)` caps a `(inbox, message)`
 * pair at one row per chatId; the only way to exceed 1 today is the replyTo
 * cross-chat path (`message.ts` writes a second row keyed by the original's
 * `replyToChat`). 8 leaves headroom for any future fan-out variant without
 * requiring a schema change here.
 */
const PUSH_CLAIM_BATCH_LIMIT = 8;

/**
 * WS-push path: atomically claim every pending entry the just-fired
 * `NOTIFY (inboxId:messageId)` references and assemble their wire payloads.
 *
 * Returns `[]` if no row matches — benign race with HTTP poll or another
 * server instance that already claimed the entry. NOTIFY is fire-and-forget
 * (proposal §3.2).
 *
 * Why an array, not a single row: `sendMessage` can write **two** rows for
 * the same `(inbox, messageId)` pair when the recipient is both a chat
 * participant and the `replyToInbox` of an earlier message — the unique key
 * is `(inbox_id, message_id, chat_id)`, so the rows differ by chatId. The
 * old `LIMIT 1` shape would only push the first; the second sat `pending`
 * until reconnect. Aligning with `pollInboxInner`'s `LIMIT N` shape closes
 * that gap and keeps push/poll behaviour interchangeable.
 */
export async function claimAndBuildForPush(
  db: Database,
  inboxId: string,
  messageId: string,
): Promise<InboxEntryWithMessage[]> {
  return withSpan("inbox.deliver.push", { "inbox.id": inboxId, "message.id": messageId }, () =>
    db.transaction(async (tx) => {
      const targetIds = tx
        .select({ id: inboxEntries.id })
        .from(inboxEntries)
        .where(
          and(
            eq(inboxEntries.inboxId, inboxId),
            eq(inboxEntries.messageId, messageId),
            eq(inboxEntries.status, "pending"),
            eq(inboxEntries.notify, true),
          ),
        )
        .orderBy(asc(inboxEntries.createdAt))
        .limit(PUSH_CLAIM_BATCH_LIMIT)
        .for("update", { skipLocked: true });

      const claimed = await tx
        .update(inboxEntries)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(inArray(inboxEntries.id, targetIds))
        .returning();

      return bundleDeliveryWithSilentContext(tx, inboxId, claimed);
    }),
  );
}

/**
 * WS-push backlog path: on agent rebind (or once an in-flight slot frees up
 * after an ack), drain up to `limit` pending `notify=true` entries oldest-
 * first and assemble wire payloads. Identical claim shape to the HTTP poll
 * path — they are intentionally interchangeable so a hot-path bug fixed in
 * one shows up in the other (proposal §3.3 / §3.5).
 */
export async function claimBacklogForPush(
  db: Database,
  inboxId: string,
  limit: number,
): Promise<InboxEntryWithMessage[]> {
  return withSpan("inbox.deliver.backlog", { "inbox.id": inboxId, "inbox.backlog.limit": limit }, () =>
    pollInboxInner(db, inboxId, limit),
  );
}

/**
 * Per claimed trigger: SELECT silent (notify=false) pending rows in the same
 * chat that occurred between the previous trigger in this batch (or beginning
 * of time) and this trigger, capped by `PRECEDING_CONTEXT_MAX_ENTRIES` and
 * `PRECEDING_CONTEXT_WINDOW_SECONDS`. Returned messages are oldest-first.
 *
 * Side effect: bulk-ack ALL silent pending rows in each chat with
 * createdAt < latest_trigger.createdAt — including ones that fell outside
 * the window/cap. Otherwise stale silent rows would accumulate and re-load
 * on every poll.
 */
async function collectPrecedingContext(
  tx: TxLike,
  inboxId: string,
  triggers: Array<Pick<ClaimedEntry, "id" | "chatId" | "createdAt">>,
): Promise<Map<number, PrecedingMessage[]>> {
  const result = new Map<number, PrecedingMessage[]>();

  // Group triggers by chatId so we can split the silent timeline per chat.
  const byChat = new Map<string, Array<Pick<ClaimedEntry, "id" | "chatId" | "createdAt">>>();
  for (const t of triggers) {
    if (t.chatId === null) continue; // replyTo cross-chat entries with no chatId can't have context
    const list = byChat.get(t.chatId) ?? [];
    list.push(t);
    byChat.set(t.chatId, list);
  }

  for (const [chatId, chatTriggers] of byChat) {
    chatTriggers.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

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
    // Concurrency: `FOR UPDATE OF inboxEntries SKIP LOCKED` prevents two
    // parallel polls on the same inbox from bundling the same silent row
    // twice. Without it, poll A picking trigger T1 and poll B picking T2
    // (T2 > T1) would both include silent rows < T1 in their preceding
    // context. With SKIP LOCKED, the second poll skips the rows the first
    // has reserved.
    let prevCreatedAt: Date | null = null;
    for (const trigger of chatTriggers) {
      const rows = await tx
        .select({
          messageId: messages.id,
          senderId: messages.senderId,
          format: messages.format,
          content: messages.content,
          metadata: messages.metadata,
          createdAt: messages.createdAt,
        })
        .from(inboxEntries)
        .innerJoin(messages, eq(messages.id, inboxEntries.messageId))
        .where(
          and(
            eq(inboxEntries.inboxId, inboxId),
            eq(inboxEntries.chatId, chatId),
            eq(inboxEntries.status, "pending"),
            eq(inboxEntries.notify, false),
            lt(inboxEntries.createdAt, trigger.createdAt),
            prevCreatedAt === null ? undefined : gt(inboxEntries.createdAt, prevCreatedAt),
            sql`${inboxEntries.createdAt} > NOW() - make_interval(secs => ${PRECEDING_CONTEXT_WINDOW_SECONDS})`,
          ),
        )
        .orderBy(desc(inboxEntries.createdAt))
        .limit(PRECEDING_CONTEXT_MAX_ENTRIES)
        .for("update", { of: inboxEntries, skipLocked: true });

      // Reverse so the prompt-rendered block reads oldest → newest.
      const preceding: PrecedingMessage[] = rows
        .map((r) => ({
          id: r.messageId,
          senderId: r.senderId,
          format: r.format,
          content: r.content,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
          createdAt: r.createdAt.toISOString(),
        }))
        .reverse();
      result.set(trigger.id, preceding);
      prevCreatedAt = trigger.createdAt;
    }

    // Bulk-ack ALL silent pending rows in this chat strictly before the
    // latest trigger — covers both "included in preceding" and "dropped due
    // to cap/window". Without this the cap-overflow rows would re-attach to
    // the next trigger and grow forever.
    const latestTrigger = chatTriggers[chatTriggers.length - 1];
    if (latestTrigger) {
      await tx
        .update(inboxEntries)
        .set({ status: "acked", ackedAt: new Date() })
        .where(
          and(
            eq(inboxEntries.inboxId, inboxId),
            eq(inboxEntries.chatId, chatId),
            eq(inboxEntries.status, "pending"),
            eq(inboxEntries.notify, false),
            lt(inboxEntries.createdAt, latestTrigger.createdAt),
          ),
        );
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

/**
 * Ack a delivered entry from the WS data plane, scoped to the inboxes the
 * connected socket has bound. Returns the acked row on success, `null` if no
 * row matches — a benign outcome the caller should ignore (the entry may
 * have already been acked, timed out, or never belonged to this socket).
 *
 * Distinct from {@link ackEntry} so the WS path can ack without trusting an
 * `inboxId` from the wire — only entries whose `inboxId` is in `inboxIds`
 * are eligible. Empty `inboxIds` short-circuits to `null`.
 */
export async function ackEntryByIdForBoundAgents(
  db: Database,
  entryId: number,
  inboxIds: string[],
): Promise<typeof inboxEntries.$inferSelect | null> {
  if (inboxIds.length === 0) return null;
  return withSpan("inbox.ack.ws", { [FIRST_TREE_HUB_ATTR.INBOX_ENTRY_ID]: String(entryId) }, async () => {
    const [entry] = await db
      .update(inboxEntries)
      .set({ status: "acked", ackedAt: new Date() })
      .where(
        and(
          eq(inboxEntries.id, entryId),
          inArray(inboxEntries.inboxId, inboxIds),
          eq(inboxEntries.status, "delivered"),
        ),
      )
      .returning();
    return entry ?? null;
  });
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
  // Reset entries that have timed out but haven't exceeded max retries.
  const reset = await db
    .update(inboxEntries)
    .set({ status: "pending", retryCount: sql`${inboxEntries.retryCount} + 1` })
    .where(
      and(
        eq(inboxEntries.status, "delivered"),
        sql`${inboxEntries.deliveredAt} < NOW() - make_interval(secs => ${timeoutSeconds})`,
        lt(inboxEntries.retryCount, maxRetries),
      ),
    )
    .returning({ id: inboxEntries.id });

  // Mark entries that have exceeded max retries as failed.
  const failed = await db
    .update(inboxEntries)
    .set({ status: "failed" })
    .where(
      and(
        eq(inboxEntries.status, "delivered"),
        sql`${inboxEntries.deliveredAt} < NOW() - make_interval(secs => ${timeoutSeconds})`,
        gte(inboxEntries.retryCount, maxRetries),
      ),
    )
    .returning({ id: inboxEntries.id });

  return { reset: reset.length, failed: failed.length };
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
 *   2. `notify=false AND status='pending' AND createdAt < NOW() - maxAge` —
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
  const ackedDeleted = await db
    .delete(inboxEntries)
    .where(and(eq(inboxEntries.notify, false), eq(inboxEntries.status, "acked")))
    .returning({ id: inboxEntries.id });

  const stalePendingDeleted = await db
    .delete(inboxEntries)
    .where(
      and(
        eq(inboxEntries.notify, false),
        eq(inboxEntries.status, "pending"),
        sql`${inboxEntries.createdAt} < NOW() - make_interval(secs => ${maxAgeSeconds})`,
      ),
    )
    .returning({ id: inboxEntries.id });

  return { ackedDeleted: ackedDeleted.length, stalePendingDeleted: stalePendingDeleted.length };
}

export async function assertInboxOwner(inboxId: string, agentInboxId: string): Promise<void> {
  if (inboxId !== agentInboxId) {
    throw new ForbiddenError("Cannot access another agent's inbox");
  }
}
