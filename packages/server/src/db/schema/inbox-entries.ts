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
     * Bundling lookup: given a notify=true trigger, find the silent pending
     * rows in the same chat to attach as preceding context.
     *
     * `id` is indexed because every caller bounds the window by id — the
     * preceding-context window (`> previous notify cursor`, `< trigger`) and
     * ACK-through's `id <= cursor` drain. Inside a LATERAL those bounds are
     * correlated values whose width the planner cannot estimate, so without
     * `id` it scans every silent row in the chat and discards almost all of
     * them.
     *
     * Partial rather than a wider composite: `status`/`notify` move into the
     * predicate instead of the key. A key ending in the unique `id` defeats
     * B-tree deduplication — the four-column form compresses ~240k rows into
     * ~7 bytes each, while appending `id` makes every key unique and costs
     * ~49 bytes each. Restricting the row set instead keeps the index small,
     * and `inbox_entries` is append-only, so excluding consumed rows matters
     * more over time than it does today.
     */
    index("idx_inbox_chat_silent_pending")
      .on(table.inboxId, table.chatId, table.id)
      .where(sql`status = 'pending' AND notify = false`),
    /**
     * Notify-cursor lookup: the previous trigger before a given entry, and
     * ACK-through's contiguous notify prefix.
     *
     * Deliberately not filtered on `status` — both callers must see notify
     * rows in any state. An already-acked trigger still closes a preceding-
     * context window, and ACK-through has to walk acked rows to prove the
     * prefix has no gap.
     */
    index("idx_inbox_chat_notify").on(table.inboxId, table.chatId, table.id).where(sql`notify = true`),
    /**
     * Message-history delivery status lookup. The chat messages API checks
     * whether any inbox row for a message is acked, delivered, or still
     * pending; keeping message_id first bounds that lookup by page size.
     */
    index("idx_inbox_entries_message_status").on(table.messageId, table.status),
    check("ck_inbox_entries_status", sql`${table.status} IN ('pending', 'delivered', 'acked')`),
  ],
);
