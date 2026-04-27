import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
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
    /** "pending" → "delivered" → "acked" | "failed" */
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
    /** Timeout reset count; entry is marked "failed" when this reaches the configured max */
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
  ],
);
