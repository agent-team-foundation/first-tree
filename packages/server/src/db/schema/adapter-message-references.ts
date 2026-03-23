import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { messages } from "./messages.js";

/** Cross-reference between internal messages and external platform message IDs. */
export const adapterMessageReferences = pgTable(
  "adapter_message_references",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    platform: text("platform").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    externalChannelId: text("external_channel_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_adapter_message_ref").on(table.messageId, table.platform)],
);
