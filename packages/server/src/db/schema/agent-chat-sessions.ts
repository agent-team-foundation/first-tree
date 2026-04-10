import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";

/** Per-session state snapshot. One row per (agent, chat) pair, upserted on each session:state message. */
export const agentChatSessions = pgTable(
  "agent_chat_sessions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.chatId] })],
);
