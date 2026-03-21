import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    senderId: text("sender_id")
      .notNull()
      .references(() => agents.id),
    format: text("format").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    replyToInbox: text("reply_to_inbox"),
    replyToChat: text("reply_to_chat"),
    inReplyTo: text("in_reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_messages_chat_time").on(table.chatId, table.createdAt),
    index("idx_messages_in_reply_to").on(table.inReplyTo),
  ],
);
