import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().default("default"),
  type: text("type").notNull().default("direct"),
  topic: text("topic"),
  lifecyclePolicy: text("lifecycle_policy").notNull().default("persistent"),
  parentChatId: text("parent_chat_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatParticipants = pgTable(
  "chat_participants",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    role: text("role").notNull().default("member"),
    mode: text("mode").notNull().default("full"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.agentId] }),
    index("idx_participants_agent").on(table.agentId),
  ],
);
