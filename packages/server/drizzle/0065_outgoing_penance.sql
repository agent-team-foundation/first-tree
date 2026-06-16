-- Chat-scoped agent-session lookup index for agent status surfaces.
--
-- `resolveAgentChatStatuses` reads `agent_chat_sessions` by chat_id when
-- hydrating one chat or one chat-list page. Keeping chat_id first lets those
-- lookups avoid scanning the `(agent_id, chat_id)` primary-key order.
--
-- Operator note:
-- Drizzle migrator executes migration files inside a transaction, so this file
-- cannot use CREATE INDEX CONCURRENTLY. For a large production table, run the
-- concurrent form manually outside a transaction before applying migrations:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_chat_sessions_chat_agent"
--     ON "agent_chat_sessions" ("chat_id", "agent_id");
--
-- The IF NOT EXISTS clause below will then skip the already-created index.
CREATE INDEX IF NOT EXISTS "idx_agent_chat_sessions_chat_agent"
  ON "agent_chat_sessions" USING btree ("chat_id", "agent_id");
