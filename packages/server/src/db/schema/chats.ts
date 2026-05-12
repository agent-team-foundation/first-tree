import { desc } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/** Communication container. All messages between agents flow within a Chat. */
export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** "direct" | "group" | "thread" */
    type: text("type").notNull().default("direct"),
    topic: text("topic"),
    lifecyclePolicy: text("lifecycle_policy").default("persistent"),
    /** Parent chat ID for thread (sub-discussion) scenarios */
    parentChatId: text("parent_chat_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Conversation-list projection columns (chat-first workspace).
     * Maintained on write by the post-fan-out projection step in
     * `services/chat-projection.ts`. Backfilled by migration 0030.
     */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: text("last_message_preview"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_chats_org_last_message").on(table.organizationId, desc(table.lastMessageAt))],
);
