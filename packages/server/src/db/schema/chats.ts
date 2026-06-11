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
    /** "direct" | "group" */
    type: text("type").notNull().default("direct"),
    topic: text("topic"),
    description: text("description"),
    lifecyclePolicy: text("lifecycle_policy").default("persistent"),
    /**
     * Decision-inert column. First Tree keeps a single group-chat model — there is no
     * sub-chat / nested-chat product layer (see first-tree-context PR #281).
     * The column is retained as schema scaffolding only; the business layer
     * never writes a non-null value and `listMeChats` defensively filters
     * `parent_chat_id IS NULL` so any historical row stays hidden from the
     * conversation list. Do NOT reintroduce nested-chat semantics here.
     */
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
