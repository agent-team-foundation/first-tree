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
    /** Cross-chat reply routing: target inbox for the reply */
    replyToInbox: text("reply_to_inbox"),
    /** Cross-chat reply routing: chat session the reply should be routed to on the receiver side */
    replyToChat: text("reply_to_chat"),
    /** Original message ID; Delivery Engine uses this to trigger replyTo routing */
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
