import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

/** Communication container. All messages between agents flow within a Chat. */
export const chats = pgTable("chats", {
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Chat participants (M:N). */
export const chatParticipants = pgTable(
  "chat_participants",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid),
    /** "owner" | "member" */
    role: text("role").notNull().default("member"),
    /** "full" = receive all messages; "mention_only" = consumer-side behavior, does not affect fan-out */
    mode: text("mode").notNull().default("full"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.agentId] }),
    index("idx_participants_agent").on(table.agentId),
  ],
);
