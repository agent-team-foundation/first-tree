import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { chats } from "./chats.js";

/**
 * Maps internal Chats to external IM platform channels.
 * NOTE: The unique constraint uses COALESCE(thread_id, '') which cannot be
 * expressed in Drizzle ORM. It is defined in the migration SQL directly as:
 *   CREATE UNIQUE INDEX uq_adapter_chat_mapping ON adapter_chat_mappings
 *     (platform, external_channel_id, COALESCE(thread_id, ''));
 */
export const adapterChatMappings = pgTable("adapter_chat_mappings", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  externalChannelId: text("external_channel_id").notNull(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id),
  threadId: text("thread_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
