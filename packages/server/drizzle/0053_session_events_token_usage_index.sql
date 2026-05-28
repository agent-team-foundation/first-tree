-- Partial index for the token-usage aggregation surface.
--
-- Aggregate queries (Team page Usage column, agent profile Usage tab)
-- shape like:
--   SELECT SUM/COUNT/MAX FROM session_events
--   WHERE agent_id = $1
--     AND kind     = 'token_usage'
--     AND created_at >= $window_start
--   ...
--
-- The existing `(agent_id, chat_id, created_at)` index covers `agent_id`
-- but forces a scan over every event kind for that agent — `token_usage`
-- is only ~1 in N events per turn (with other kinds: tool_call, thinking,
-- assistant_text, turn_end). Partial-index on this single kind so per-agent
-- aggregation stays bounded as `session_events` grows.
--
-- Companion to `idx_session_events_context_tree_usage_recent` (0046):
-- same partial-index pattern, different kind + different ordering need
-- (per-agent here vs. global-recent there).
CREATE INDEX "idx_session_events_token_usage_agent_recent"
  ON "session_events" USING btree ("agent_id", "created_at" DESC)
  WHERE "kind" = 'token_usage';
