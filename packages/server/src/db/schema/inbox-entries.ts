import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { messages } from "./messages.js";

/** Delivery queue (envelope). One entry per recipient created during message fan-out. Uses SKIP LOCKED for concurrent-safe consumption. */
export const inboxEntries = pgTable(
  "inbox_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Target agent's inbox address */
    inboxId: text("inbox_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    /** Routing tag. May differ from message.chat_id in replyTo scenarios; used by Client to route to the correct Session */
    chatId: text("chat_id"),
    /** "pending" -> "delivered" -> "acked" */
    status: text("status").notNull().default("pending"),
    /**
     * When `false`, the entry is a "silent context" row: written so future
     * deliveries can replay it as preceding chat history, but never wakes the
     * recipient's session on its own and is not visible to the dispatcher's
     * `pollInbox` claim. Group-chat fan-out sets this to `false` for
     * `mention_only` participants who weren't named in the triggering message.
     * Notify=true entries are the normal "active" deliverables.
     */
    notify: boolean("notify").notNull().default(true),
    /** Reserved legacy counter; delivery recovery does not dead-letter rows. */
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_inbox_delivery").on(table.inboxId, table.messageId, table.chatId),
    index("idx_inbox_pending").on(table.inboxId, table.createdAt),
    /**
     * Partial index for the pollInbox claim hot-path. Without `notify` in the
     * index, a chat that accumulates silent rows forces the planner to scan
     * past them to find the next notify=true trigger; with this partial
     * index the lookup is bounded by the trigger count alone.
     */
    index("idx_inbox_pending_notify")
      .on(table.inboxId, table.createdAt)
      .where(sql`status = 'pending' AND notify = true`),
    /**
     * Bundling lookup: given a notify=true trigger, find all silent pending
     * rows in the same chat that should be attached as preceding context.
     * Composite shape mirrors the actual WHERE clause used in pollInbox.
     */
    index("idx_inbox_chat_silent").on(table.inboxId, table.chatId, table.notify, table.status),
    /**
     * Message-history delivery status lookup. The chat messages API checks
     * whether any inbox row for a message is acked, delivered, or still
     * pending; keeping message_id first bounds that lookup by page size.
     */
    index("idx_inbox_entries_message_status").on(table.messageId, table.status),
    /**
     * ACK-through cursor window. `ackThroughEntryIdForBoundAgents` walks the
     * `(inbox_id, chat_id)` partition up to the acked cursor; without this
     * index the planner falls back to the primary key and scans — and locks —
     * every notify row ever written to the chat, which is what made ACK cost
     * O(history) and lifetime cost O(N^2).
     *
     * `acked` is a terminal state (nothing resets an acked row back to
     * `pending`/`delivered`), so restricting the index to non-acked rows keeps
     * it sized to the live in-flight window instead of to chat history.
     *
     * Shape notes, all load-bearing:
     *   - `notify` sits in the key rather than in the predicate on purpose.
     *     A partial index is only usable when the planner can prove the query
     *     implies its predicate, and under a generic plan a bound parameter
     *     proves nothing. The service passes `notify` as a parameter
     *     (`eq(inboxEntries.notify, true)`), so a `WHERE notify = true`
     *     predicate would silently stop matching; as a key column the same
     *     parameter is just an ordinary index condition. This keeps the index
     *     dependent on exactly one inlined literal instead of two.
     *   - `id` is the last key column, so `id <= cursor` is an index range
     *     condition and `ORDER BY id` needs no sort.
     *   - The predicate is spelled `status <> 'acked'` to match the query
     *     clause verbatim; see the `NOT_ACKED_PREFIX_ROW` note in
     *     services/inbox.ts for why that clause must stay a literal.
     */
    index("idx_inbox_unacked_cursor")
      .on(table.inboxId, table.chatId, table.notify, table.id)
      .where(sql`status <> 'acked'`),
    check("ck_inbox_entries_status", sql`${table.status} IN ('pending', 'delivered', 'acked')`),
  ],
);
