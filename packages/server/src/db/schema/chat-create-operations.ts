import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { messages } from "./messages.js";

export const chatCreateOperations = pgTable(
  "chat_create_operations",
  {
    senderAgentId: text("sender_agent_id")
      .notNull()
      .references(() => agents.uuid),
    operationId: text("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    chatId: text("chat_id").references(() => chats.id),
    messageId: text("message_id").references(() => messages.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.senderAgentId, table.operationId] }),
    index("idx_chat_create_operations_chat").on(table.chatId),
    index("idx_chat_create_operations_message").on(table.messageId),
  ],
);
