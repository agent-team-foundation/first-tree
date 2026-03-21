import { bigserial, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { messages } from "./messages.js";

export const inboxEntries = pgTable(
  "inbox_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    inboxId: text("inbox_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    chatId: text("chat_id"),
    status: text("status").notNull().default("pending"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_inbox_delivery").on(table.inboxId, table.messageId, table.chatId),
    index("idx_inbox_pending").on(table.inboxId, table.createdAt),
  ],
);
