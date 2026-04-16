import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Session outputs — aggregated text output from agent sessions.
 * One row per (agent, chat) session. Content is appended as the agent works.
 * Cleaned up when the session is evicted.
 */
export const sessionOutputs = pgTable(
  "session_outputs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    chatId: text("chat_id").notNull(),
    content: text("content").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_session_outputs_agent_chat").on(table.agentId, table.chatId),
    index("idx_session_outputs_agent_chat").on(table.agentId, table.chatId),
  ],
);
