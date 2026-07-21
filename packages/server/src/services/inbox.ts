import {
  type InboxEntryWithMessage,
  inboxEntryStatusSchema,
  messageSourceSchema,
  type PrecedingMessage,
} from "@first-tree/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { ForbiddenError } from "../errors.js";
import { FIRST_TREE_ATTR, withSpan } from "../observability/index.js";
import { buildClientMessagePayloadsForInbox } from "./message-dispatcher.js";

/** Claimed `inbox_entries` row, typed via Drizzle `$inferSelect` so column-mode
 *  conversions (bigserial → number, timestamp → Date) flow through. */
type ClaimedEntry = typeof inboxEntries.$inferSelect;

export type AckEntryResult =
  | {
      ok: true;
      throughEntry: typeof inboxEntries.$inferSelect;
      disposition: "acked" | "already_acked" | "accepted_from_pending";
      ackedCount: number;
      ackedEntryIds: number[];
    }
  | { ok: false; reason: "not_found_or_not_bound" | "non_notify" | "prefix_gap" };

/** Structurally-typed DB so both `Database` and transaction clients work. */
type TxLike = Pick<PostgresJsDatabase<Record<string, never>>, "select" | "update" | "delete" | "insert">;

/** Wider DB shape that matches both the concrete `Database` and the
 *  `PgDatabase` widening used by sibling services (e.g. participant-mode).
 *  Used by entrypoints that need to accept a tx handed in from outside this
 *  module. The narrower `TxLike` is retained for module-internal callers. */
// biome-ignore lint/suspicious/noExplicitAny: needed for cross-schema compatibility
type WideTxLike = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Caps for the silent-context replay attached to an active delivery (proposal
 * §1). The window keeps stale chatter out of the prompt; the cap protects
 * against runaway batches if a chat is very chatty between two mentions of
 * the same agent. Older / overflow silent rows are excluded from the prompt
 * window but drained later when ACK-through commits the notify delivery.
 *
 * Exported (test-only) so the cap-overflow test doesn't have to spam 50+
 * silent messages — it pins the invariant by reading the constant.
 */
export const PRECEDING_CONTEXT_MAX_ENTRIES = 50;
export const PRECEDING_CONTEXT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Backfill the most recent `PRECEDING_CONTEXT_MAX_ENTRIES` messages of `chatId`
 * as silent (notify=false) inbox rows for every new participant. Called from
 * `addParticipant()` inside the participant-insert transaction so a freshly
 * added member already has prior chat history available the first time they
 * are woken (mentioned / `chat send`-ed).
 *
 * Invariants the implementation upholds:
 *
 *   - **`notify=false` everywhere**: adding a participant is not itself a
 *     wake event. The new participant only runs the LLM when an actual
 *     trigger lands later; the backfill rows then piggy-back as preceding
 *     context (see `collectPrecedingContext`).
 *   - **Old members are not woken**: only inbox rows for the brand-new
 *     participants are written.
 *   - **Transaction-scoped**: writes go through the caller's `tx`, so a
 *     rollback of `addParticipant` rolls the backfill back too.
 *   - **Quiet on chats with no prior history**: a chat with zero messages
 *     produces zero backfill rows; no error, no INSERT.
 *   - **Idempotent**: collides cleanly on the
 *     `(inbox_id, message_id, chat_id)` unique key via
 *     `ON CONFLICT DO NOTHING`. This matters when a watcher → speaker
 *     promotion already had inbox rows for some of these messages.
 *
 * Pure data write — no PG NOTIFY, no participant-mode logic, no watcher
 * recompute. Callers stay responsible for those.
 *
 * **Caller responsibility — bulk batching**: writes a single
 * `INSERT VALUES (...)` of `newParticipants.length * PRECEDING_CONTEXT_MAX_ENTRIES`
 * tuples. v1's only caller (`addParticipant`) always passes 1 participant
 * (≤ 50 rows). Any future bulk-add caller should chunk input (suggested:
 * ≤ 512 rows per call) before passing here.
 *
 * See proposals/hub-chat-message-v1-design §四 改造 2.
 */
export async function backfillSilentContextForNewParticipants(
  tx: WideTxLike,
  chatId: string,
  newParticipants: ReadonlyArray<{ inboxId: string }>,
): Promise<void> {
  if (newParticipants.length === 0) return;

  const recent = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt))
    .limit(PRECEDING_CONTEXT_MAX_ENTRIES);

  if (recent.length === 0) return;

  const rows: Array<{ inboxId: string; messageId: string; chatId: string; notify: boolean }> = [];
  for (const p of newParticipants) {
    for (const m of recent) {
      rows.push({ inboxId: p.inboxId, messageId: m.id, chatId, notify: false });
    }
  }

  await tx.insert(inboxEntries).values(rows).onConflictDoNothing();
}

export async function pollInbox(db: Database, inboxId: string, limit: number) {
  return withSpan("inbox.deliver", { "inbox.id": inboxId, "inbox.poll.limit": limit }, () =>
    pollInboxInner(db, inboxId, limit),
  );
}

async function pollInboxInner(db: Database, inboxId: string, limit: number, chatId?: string) {
  return db.transaction(async (tx) => {
    // Claim pending notify=true entries (active triggers). Silent rows
    // (notify=false) are intentionally excluded — they piggy-back on the
    // next active delivery in their chat as preceding context (proposal §1).
    //
    // The subquery's `FOR UPDATE SKIP LOCKED` is what keeps concurrent
    // pollers / WS-push handlers from claiming the same row twice. The outer
    // UPDATE then flips status to 'delivered' on whichever rows the subquery
    // successfully locked — canonical PG SKIP-LOCKED queue idiom.
    const targetIds =
      chatId === undefined
        ? tx
            .select({ id: inboxEntries.id })
            .from(inboxEntries)
            .where(
              and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.status, "pending"), eq(inboxEntries.notify, true)),
            )
            .orderBy(asc(inboxEntries.id))
            .limit(limit)
            .for("update", { skipLocked: true })
        : tx
            .select({ id: inboxEntries.id })
            .from(inboxEntries)
            .where(
              and(
                eq(inboxEntries.inboxId, inboxId),
                eq(inboxEntries.chatId, chatId),
                eq(inboxEntries.status, "pending"),
                eq(inboxEntries.notify, true),
              ),
            )
            .orderBy(asc(inboxEntries.id))
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
 * `pollInbox`, the production WS backlog drain, and the exact-message
 * prefix-claim helper call this with rows they have just `UPDATE`d to
 * `status='delivered'`. Keeping the silent-context bundling in one place is
 * the only way to keep delivery paths from drifting (proposal
 * hub-inbox-ws-data-plane §3.2 risk #1).
 *
 * Steps:
 *   1. Sort by inbox `id` ASC (PG `RETURNING` does not guarantee order).
 *   2. For each trigger, collect silent context without consuming silent rows.
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

  // PostgreSQL's UPDATE...RETURNING does not guarantee row order, so sort by
  // the delivery cursor. ACK-through uses `id <= cursor`; delivery cannot use
  // `createdAt` as a separate prefix order without making that cursor unsafe.
  claimed.sort((a, b) => a.id - b.id);

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
      status: inboxEntryStatusSchema.parse(entry.status),
      retryCount: entry.retryCount,
      createdAt: entry.createdAt.toISOString(),
      deliveredAt: entry.deliveredAt?.toISOString() ?? null,
      ackedAt: entry.ackedAt?.toISOString() ?? null,
      message: payload,
    };
  });
}

/**
 * Exact-message prefix-claim helper: find the pending target entry for a
 * `messageId`, then atomically claim the same-chat pending prefix through
 * that target.
 *
 * Production WS delivery no longer exact-claims NOTIFY message ids; it treats
 * NOTIFY as a wake-up hint and drains backlog through `claimBacklogForPushFair`.
 * This helper remains for direct tests and any explicit exact-message claim
 * callers that need the same ack-through prefix safety.
 *
 * Returns `[]` if no row matches — benign race with another server instance
 * (or the debug `GET /inbox` endpoint) that already claimed the entry.
 * NOTIFY is fire-and-forget (proposal §3.2).
 *
 * Ack-through safety depends on this prefix behavior: a higher-id entry must
 * not be claimed/sent while a lower-id same-chat pending entry remains
 * invisible to the client attempt. Callers that send the returned frames must
 * preserve the returned id order.
 */
export async function claimAndBuildForPush(
  db: Database,
  inboxId: string,
  messageId: string,
): Promise<InboxEntryWithMessage[]> {
  return withSpan("inbox.deliver.push", { "inbox.id": inboxId, "message.id": messageId }, () =>
    db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: inboxEntries.id, chatId: inboxEntries.chatId })
        .from(inboxEntries)
        .where(
          and(
            eq(inboxEntries.inboxId, inboxId),
            eq(inboxEntries.messageId, messageId),
            eq(inboxEntries.status, "pending"),
            eq(inboxEntries.notify, true),
          ),
        )
        .orderBy(asc(inboxEntries.id))
        .for("update")
        .limit(1);
      if (!target) return [];

      const chatPredicate =
        target.chatId === null ? isNull(inboxEntries.chatId) : eq(inboxEntries.chatId, target.chatId);
      const targetIds = tx
        .select({ id: inboxEntries.id })
        .from(inboxEntries)
        .where(
          and(
            eq(inboxEntries.inboxId, inboxId),
            chatPredicate,
            eq(inboxEntries.status, "pending"),
            eq(inboxEntries.notify, true),
            sql`${inboxEntries.id} <= ${target.id}`,
          ),
        )
        .orderBy(asc(inboxEntries.id))
        .for("update");

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
 * Oldest-first backlog path. Kept for debug parity with `pollInbox` and
 * direct service tests; normal WS delivery uses `claimBacklogForPushFair` so a
 * single chat cannot consume the agent's whole in-flight window.
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
 * Chat-scoped WS backlog path used after same-socket recovery. It mirrors
 * `claimBacklogForPush`, but limits the claim to the chat that asked for
 * recovery so another chat's backlog cannot consume the recovery window.
 */
export async function claimBacklogForPushForChat(
  db: Database,
  inboxId: string,
  chatId: string,
  limit: number,
): Promise<InboxEntryWithMessage[]> {
  return withSpan(
    "inbox.deliver.backlog.chat",
    { "inbox.id": inboxId, "chat.id": chatId, "inbox.backlog.limit": limit },
    () => pollInboxInner(db, inboxId, limit, chatId),
  );
}

export type ClaimBacklogForPushFairChatBudget = {
  chatId: string | null;
  remaining: number;
};

function fairBudgetKey(chatId: string | null): string {
  return chatId === null ? "null" : `chat:${chatId}`;
}

/**
 * Fair WS backlog path for normal agent drains. It keeps the old backlog
 * helper's same-chat id order, but chooses across chats by chat-local rank so
 * one noisy/stuck chat cannot consume every delivered-but-unacked slot.
 *
 * `chatBudgets` only needs entries for chats whose current in-flight count
 * reduces their remaining budget. Chats absent from the list receive
 * `defaultPerChatLimit`.
 */
export async function claimBacklogForPushFair(
  db: Database,
  inboxId: string,
  opts: {
    limit: number;
    defaultPerChatLimit: number;
    chatBudgets: readonly ClaimBacklogForPushFairChatBudget[];
  },
): Promise<InboxEntryWithMessage[]> {
  if (opts.limit <= 0 || opts.defaultPerChatLimit <= 0) return [];

  const normalizedBudgets = new Map<string, { chat_id: string | null; remaining: number }>();
  for (const budget of opts.chatBudgets) {
    normalizedBudgets.set(fairBudgetKey(budget.chatId), {
      chat_id: budget.chatId,
      remaining: Math.max(0, Math.floor(budget.remaining)),
    });
  }
  const budgetJson = JSON.stringify([...normalizedBudgets.values()]);

  return withSpan(
    "inbox.deliver.backlog.fair",
    {
      "inbox.id": inboxId,
      "inbox.backlog.limit": opts.limit,
      "inbox.backlog.per_chat_limit": opts.defaultPerChatLimit,
    },
    () =>
      db.transaction(async (tx) => {
        const selected = await tx.execute<{ id: number | string }>(sql`
          WITH chat_budget AS (
            SELECT budget.chat_id, budget.remaining
              FROM jsonb_to_recordset(${budgetJson}::jsonb) AS budget(chat_id text, remaining integer)
          ),
          ranked AS (
            SELECT
              e.id,
              e.chat_id,
              row_number() OVER (PARTITION BY e.chat_id ORDER BY e.id) AS chat_rank
            FROM inbox_entries e
            WHERE e.inbox_id = ${inboxId}
              AND e.status = 'pending'
              AND e.notify = true
          ),
          eligible AS (
            SELECT ranked.id, ranked.chat_rank
              FROM ranked
              LEFT JOIN chat_budget
                ON ranked.chat_id IS NOT DISTINCT FROM chat_budget.chat_id
             WHERE ranked.chat_rank <= COALESCE(chat_budget.remaining, ${opts.defaultPerChatLimit})
             ORDER BY ranked.chat_rank, ranked.id
             LIMIT ${opts.limit}
          ),
          locked AS (
            SELECT e.id, eligible.chat_rank
              FROM inbox_entries e
              INNER JOIN eligible ON eligible.id = e.id
             WHERE e.inbox_id = ${inboxId}
               AND e.status = 'pending'
               AND e.notify = true
             ORDER BY eligible.chat_rank, e.id
             FOR UPDATE OF e SKIP LOCKED
          )
          SELECT locked.id
            FROM locked
           ORDER BY locked.chat_rank, locked.id
        `);

        const targetIds = selected.map((row) => {
          const id = typeof row.id === "number" ? row.id : Number(row.id);
          if (!Number.isSafeInteger(id)) throw new Error(`Unexpected inbox entry id from fair claim: ${row.id}`);
          return id;
        });
        if (targetIds.length === 0) return [];

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
 * Per claimed trigger: SELECT silent (notify=false) pending rows in the same
 * chat that occurred between the previous trigger in this batch (or beginning
 * of time) and this trigger, capped by `PRECEDING_CONTEXT_MAX_ENTRIES` and
 * `PRECEDING_CONTEXT_WINDOW_SECONDS`. Returned messages are oldest-first.
 *
 * This function intentionally does not ACK silent rows. Bundling is not
 * consumption: recovery must be able to reset the notify trigger and rebuild
 * the same trigger-relative context window. Silent rows are drained only when
 * the client ACKs the consumed notify entry.
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
    if (t.chatId === null) continue; // defensive: legacy / null-chatId rows can't have context
    const list = byChat.get(t.chatId) ?? [];
    list.push(t);
    byChat.set(t.chatId, list);
  }

  for (const [chatId, chatTriggers] of byChat) {
    chatTriggers.sort((a, b) => a.id - b.id);

    const firstTrigger = chatTriggers[0];
    if (!firstTrigger) continue;
    const [previousNotify] = await tx
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, inboxId),
          eq(inboxEntries.chatId, chatId),
          eq(inboxEntries.notify, true),
          lt(inboxEntries.id, firstTrigger.id),
        ),
      )
      .orderBy(desc(inboxEntries.id))
      .limit(1);

    // For each trigger, fetch silent context strictly before it (and after
    // the previous notify trigger cursor, even if that trigger was delivered
    // in an earlier unacked batch). Window: 24h before the trigger.
    //
    // Order matters: when there are MORE than `PRECEDING_CONTEXT_MAX_ENTRIES`
    // candidates, we want to keep the rows CLOSEST to the trigger (most
    // contextually relevant) and drop the oldest. So select DESC + LIMIT,
    // then reverse in JS to get chronological prompt-ready output. Selecting
    // ASC + LIMIT would drop the recent rows; ACK-through later drains every
    // silent row behind the consumed notify cursor, including rows excluded by
    // this cap, so this delivery must choose the most relevant window now.
    //
    // We sort by `messages.createdAt` rather than `inboxEntries.createdAt`
    // because `addParticipant`'s backfill writes 50 inbox rows in one
    // `INSERT VALUES (...)` — they all share `statement_timestamp()`. The
    // message rows themselves have distinct, monotonic timestamps (uuidv7
    // ids are time-ordered, `messages.created_at` is the authoritative
    // chronology), so ordering by the joined message timestamp is the only
    // stable contract the prompt-rendered context can rely on.
    //
    // Concurrency: `FOR UPDATE OF inboxEntries SKIP LOCKED` prevents two
    // parallel polls on the same inbox from bundling the same silent row
    // twice. Without it, poll A picking trigger T1 and poll B picking T2
    // (T2 > T1) would both include silent rows < T1 in their preceding
    // context. With SKIP LOCKED, the second poll skips the rows the first
    // has reserved.
    let previousNotifyId: number | null = previousNotify?.id ?? null;
    for (const trigger of chatTriggers) {
      const windowStart = new Date(trigger.createdAt.getTime() - PRECEDING_CONTEXT_WINDOW_SECONDS * 1000);
      const rows = await tx
        .select({
          messageId: messages.id,
          senderId: messages.senderId,
          format: messages.format,
          content: messages.content,
          metadata: messages.metadata,
          source: messages.source,
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
            lt(inboxEntries.id, trigger.id),
            previousNotifyId === null ? undefined : gt(inboxEntries.id, previousNotifyId),
            gt(inboxEntries.createdAt, windowStart),
          ),
        )
        .orderBy(desc(messages.createdAt))
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
          source: messageSourceSchema.nullable().catch(null).parse(r.source),
          createdAt: r.createdAt.toISOString(),
        }))
        .reverse();
      result.set(trigger.id, preceding);
      previousNotifyId = trigger.id;
    }
  }

  return result;
}

/**
 * Commit inbox progress through the supplied entry id from the WS data plane,
 * scoped to the inboxes the connected socket has bound.
 *
 * `entryId` is interpreted as a cursor, not as an exact single-row ack:
 * every notify=true row in the same `(inboxId, chatId)` partition up to that
 * id must already be `acked` or `delivered`. Delivered rows in that contiguous
 * prefix are atomically marked `acked`; non-committable gaps reject the commit
 * so the database cannot persist `A pending, B acked`.
 *
 * Trusts only the `inboxId` set the connected socket has bound (no `inboxId`
 * on the wire), and short-circuits on an empty `inboxIds`.
 */
export async function ackThroughEntryIdForBoundAgents(
  db: Database,
  entryId: number,
  inboxIds: string[],
): Promise<AckEntryResult> {
  if (inboxIds.length === 0) return { ok: false, reason: "not_found_or_not_bound" };
  return withSpan("inbox.ack.ws", { [FIRST_TREE_ATTR.INBOX_ENTRY_ID]: String(entryId) }, async () => {
    return db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(inboxEntries)
        .where(and(eq(inboxEntries.id, entryId), inArray(inboxEntries.inboxId, inboxIds)))
        .for("update")
        .limit(1);
      if (!entry) return { ok: false, reason: "not_found_or_not_bound" };
      if (!entry.notify) return { ok: false, reason: "non_notify" };

      const chatPredicate = entry.chatId === null ? isNull(inboxEntries.chatId) : eq(inboxEntries.chatId, entry.chatId);
      const prefixRows = await tx
        .select()
        .from(inboxEntries)
        .where(
          and(
            eq(inboxEntries.inboxId, entry.inboxId),
            chatPredicate,
            eq(inboxEntries.notify, true),
            sql`${inboxEntries.id} <= ${entryId}`,
          ),
        )
        .orderBy(asc(inboxEntries.id))
        .for("update");

      const isResetDeliveredRow = (row: ClaimedEntry): boolean => row.status === "pending" && row.deliveredAt !== null;
      if (prefixRows.some((row) => row.status !== "acked" && row.status !== "delivered" && !isResetDeliveredRow(row))) {
        return { ok: false, reason: "prefix_gap" };
      }

      const deliveredIds = prefixRows.filter((row) => row.status === "delivered").map((row) => row.id);
      const resetPendingIds = prefixRows.filter(isResetDeliveredRow).map((row) => row.id);
      const committableIds = [...deliveredIds, ...resetPendingIds];
      const ackedAt = new Date();
      const drainPendingSilentRows = async (): Promise<void> => {
        await tx
          .update(inboxEntries)
          .set({ status: "acked", ackedAt })
          .where(
            and(
              eq(inboxEntries.inboxId, entry.inboxId),
              chatPredicate,
              eq(inboxEntries.status, "pending"),
              eq(inboxEntries.notify, false),
              sql`${inboxEntries.id} <= ${entryId}`,
            ),
          );
      };

      if (committableIds.length === 0) {
        await drainPendingSilentRows();
        return {
          ok: true,
          throughEntry: entry,
          disposition: "already_acked",
          ackedCount: 0,
          ackedEntryIds: [],
        };
      }

      const updated = await tx
        .update(inboxEntries)
        .set({ status: "acked", ackedAt })
        .where(and(inArray(inboxEntries.id, committableIds), inArray(inboxEntries.status, ["delivered", "pending"])))
        .returning();
      await drainPendingSilentRows();
      const updatedThroughEntry = updated.find((row) => row.id === entryId) ?? entry;
      return {
        ok: true,
        throughEntry: updatedThroughEntry,
        disposition: resetPendingIds.length > 0 ? "accepted_from_pending" : "acked",
        ackedCount: updated.length,
        ackedEntryIds: updated.map((row) => row.id),
      };
    });
  });
}

export const ackEntryByIdForBoundAgents = ackThroughEntryIdForBoundAgents;

export type RecoverUnackedForScopeResult = {
  resetEntryIds: number[];
};

/**
 * Reset delivered-but-unacked notify rows for a single inbox, optionally
 * narrowed to one chat, and return the concrete ids that were reset. The id
 * list lets the WS layer remove only those entries from same-socket in-flight
 * accounting before it redelivers them.
 */
export async function recoverUnackedForScope(
  db: Database,
  opts: { inboxId: string; chatId?: string },
): Promise<RecoverUnackedForScopeResult> {
  const reset = await db
    .update(inboxEntries)
    .set({ status: "pending" })
    .where(
      opts.chatId === undefined
        ? and(
            eq(inboxEntries.inboxId, opts.inboxId),
            eq(inboxEntries.status, "delivered"),
            eq(inboxEntries.notify, true),
          )
        : and(
            eq(inboxEntries.inboxId, opts.inboxId),
            eq(inboxEntries.chatId, opts.chatId),
            eq(inboxEntries.status, "delivered"),
            eq(inboxEntries.notify, true),
          ),
    )
    .returning({ id: inboxEntries.id });
  return { resetEntryIds: reset.map((row) => row.id) };
}

/**
 * Reset every `delivered` entry across the given `inboxIds` back to `pending`
 * so a subsequent `claimBacklogForPush` re-includes them. Called from the
 * `agent:bind` path: a freshly-connected client may not have acked entries
 * the previous WS push delivered before the connection dropped (or the
 * client crashed). `retryCount` is intentionally NOT incremented — a crash or
 * reconnect is recovery state, not a delivery-attempt failure.
 *
 * Returns the number of rows reset so the caller can log meaningful counts.
 * Short-circuits on empty `inboxIds`.
 *
 * See docs/inflight-message-recovery-design.md §4.
 */
export async function resetDeliveredForInboxes(db: Database, inboxIds: string[]): Promise<number> {
  if (inboxIds.length === 0) return 0;
  const reset = await db
    .update(inboxEntries)
    .set({ status: "pending" })
    .where(and(inArray(inboxEntries.inboxId, inboxIds), eq(inboxEntries.status, "delivered")))
    .returning({ id: inboxEntries.id });
  return reset.length;
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
 *      consumed by ACK-through after a notify trigger commits); keep them only as long as
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
