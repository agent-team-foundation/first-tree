import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Session events — structured event stream per (agent, chat) session.
 * `kind` is one of `'tool_call' | 'error' | 'assistant_text' | 'thinking'
 * | 'turn_end'`; payload shape per kind is enforced by the service layer
 * via Zod (no FK / CHECK on this table per project rule).
 *
 * `seq` is monotonic per (agent_id, chat_id). The single-writer invariant
 * in the client-side session-manager guarantees ordering; the service wraps
 * the insert in a MAX(seq)+1 retry loop to recover from restart-overlap
 * windows.
 *
 * Cleanup: rows are dropped when the session is evicted or terminated —
 * see sessionEventService.clearEvents.
 */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    chatId: text("chat_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_session_events_chat_seq").on(table.agentId, table.chatId, table.seq),
    index("idx_session_events_chat_created").on(table.agentId, table.chatId, table.createdAt.desc()),
    index("idx_session_events_context_tree_usage_recent")
      .on(table.createdAt.desc())
      .where(sql`${table.kind} = 'context_tree_usage'`),
    index("idx_session_events_context_tree_io_agent_recent")
      .on(table.agentId, table.createdAt.desc())
      .where(sql`${table.kind} IN ('context_tree_usage', 'tool_call')`),
    // Partial index for the agent-scoped token-usage aggregation (Team page
    // Usage column, agent profile Usage tab). The general
    // `(agent_id, chat_id, created_at)` index forces a scan over every event
    // kind for an agent; this one only indexes `token_usage` rows so
    // per-agent SUM / COUNT stays bounded as session_events grows.
    index("idx_session_events_token_usage_agent_recent")
      .on(table.agentId, table.createdAt.desc())
      .where(sql`${table.kind} = 'token_usage'`),
  ],
);
