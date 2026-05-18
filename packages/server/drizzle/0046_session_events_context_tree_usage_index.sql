-- Partial index for the Context Tab usage feed.
--
-- The org-wide "agents used the tree" feed queries:
--   SELECT ... FROM session_events
--   INNER JOIN agents ON agents.uuid = session_events.agent_id
--   LEFT JOIN chats   ON chats.id = session_events.chat_id AND chats.organization_id = $1
--   WHERE agents.organization_id = $1
--     AND session_events.kind = 'context_tree_usage'
--     AND session_events.created_at >= $since
--   ORDER BY session_events.created_at DESC
--   LIMIT 50;
--
-- The existing (agent_id, chat_id, created_at) index does not match this
-- shape — without a kind-filtered index, PG falls back to scanning recent
-- rows or sorting the full window. Partial-index this on the single kind
-- that this feed cares about so the cost stays bounded as session_events
-- grows.
CREATE INDEX "idx_session_events_context_tree_usage_recent"
  ON "session_events" USING btree ("created_at" DESC)
  WHERE "kind" = 'context_tree_usage';
