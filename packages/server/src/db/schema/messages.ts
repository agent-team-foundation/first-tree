import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { chats } from "./chats.js";

/** Messages. Immutable after creation. Each message belongs to exactly one Chat. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    /** No FK constraint — agents may be soft-deleted while messages are preserved. */
    senderId: text("sender_id").notNull(),
    /** "text" | "markdown" | "card" | "reference" | "file" */
    format: text("format").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Decision-inert column. Originally an inbox-row-level reply-routing
     * envelope paired with the now-removed `replyToChat` cross-chat hint;
     * once cross-chat routing went away there were no consumers left (the
     * receive-side `shouldSuppressEcho` was deleted with it). The column
     * survives as schema scaffolding only — the business layer never writes
     * a non-null value. Do NOT reintroduce reply-routing envelopes here;
     * inbox fan-out is sufficient, see first-tree-context PR #281.
     */
    replyToInbox: text("reply_to_inbox"),
    /**
     * Decision-inert column. Originally part of a cross-chat reply-routing
     * mechanism that has been removed (see first-tree-context PR #281).
     * The column is retained as schema scaffolding only — the business layer
     * never writes a non-null value. Do NOT reintroduce cross-chat reply
     * routing through this column.
     */
    replyToChat: text("reply_to_chat"),
    /** Original message ID; threads replies in the same chat. */
    inReplyTo: text("in_reply_to"),
    /** Entry point that created this message: hub_ui / cli / feishu / github / api */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_messages_chat_time").on(table.chatId, table.createdAt),
    index("idx_messages_in_reply_to").on(table.inReplyTo),
  ],
);
