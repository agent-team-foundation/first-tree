import { desc } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
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

/** Speaking participants of a chat (M:N). Watchers live in chat_subscriptions. */
export const chatParticipants = pgTable(
  "chat_participants",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid),
    /** "owner" | "member" — speaking participants only. Watchers = chat_subscriptions row. */
    role: text("role").notNull().default("member"),
    /** "full" = receive all messages; "mention_only" = consumer-side behavior, does not affect fan-out */
    mode: text("mode").notNull().default("full"),
    /** Per-user read cursor for the chat-first workspace conversation list. */
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    /** Maintained on write by mention-propagation in `services/chat-projection.ts`. */
    unreadMentionCount: integer("unread_mention_count").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.agentId] }),
    index("idx_participants_agent").on(table.agentId),
  ],
);

/**
 * Non-speaking observers ("watchers"). Used by the chat-first workspace so a
 * user can supervise chats their managed agents participate in without
 * accidentally being part of fan-out.
 *
 * Invariants:
 *   1. (chat_id, agent_id) is mutually exclusive with chat_participants.
 *   2. Rows here NEVER produce inbox_entries (fan-out exclusivity).
 *   3. Mention candidate resolution NEVER includes these rows.
 *   4. State transitions (join/leave) carry last_read_at + counter; lifecycle
 *      recomputes default to NULL/0 and MUST NOT run on the join/leave path.
 *
 * See docs/chat-first-workspace-product-design.md "Data Model" + "State
 * Transitions" for the full contract.
 */
export const chatSubscriptions = pgTable(
  "chat_subscriptions",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid),
    /** Future-extensible enum. Today: 'watching'. */
    kind: text("kind").notNull().default("watching"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    unreadMentionCount: integer("unread_mention_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.agentId] }),
    index("idx_chat_subscriptions_agent").on(table.agentId),
  ],
);
