-- Pre-flight collision probe for the chat data model restructure
-- (migration 0038_chat_membership_user_state).
--
-- WHEN to run:
--   1. Against staging FIRST — archive output for review.
--   2. Then against a prod read replica — archive output too.
--   Both must come back clean before 0038 enters prod. If Probe 1
--   surfaces collisions, investigate the write path before deploying;
--   the migration's speaker-wins ON CONFLICT DO UPDATE will still
--   resolve the row, but the surprise itself is a service-layer bug.
--
-- HOW to run (read-only, safe on prod replica):
--   psql "$DATABASE_URL" -f packages/server/drizzle/probes/0038_chat_membership_user_state.pre-flight.sql > 0038.pre-flight.<env>.txt
--
-- Background: this artifact was originally drafted in the design proposal
-- (first-tree-context PR #253) but executable SQL belongs alongside the
-- migration it probes, not in design-docs.

-- ──────────────────────────────────────────────────────────────────────
-- Probe 1: invariant-1 (mutual exclusion) violations.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: 0 rows.
-- If non-zero, the speaker row WILL win during the back-fill (0038
-- explicit merge policy: chat_membership ← chat_participants then
-- DO NOTHING on the chat_subscriptions branch), but the surprise should
-- be investigated first — it indicates a write path that bypassed the
-- service-layer mutual-exclusion guard.

SELECT
  cp.chat_id,
  cp.agent_id,
  cp.last_read_at AS participant_last_read_at,
  cs.last_read_at AS subscription_last_read_at,
  cp.unread_mention_count AS participant_unread,
  cs.unread_mention_count AS subscription_unread
FROM chat_participants cp
JOIN chat_subscriptions cs USING (chat_id, agent_id);

-- ──────────────────────────────────────────────────────────────────────
-- Probe 2: orphan agent_id references.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: 0 rows.
-- An agent_id that exists in chat_participants / chat_subscriptions but
-- has no matching agents.uuid is a soft-delete-after-hard-delete leak.
-- The migration's data back-fill will carry these rows over (no agent FK
-- on the new tables either) but they will never be reachable by any
-- service — they should be cleaned up pre-cutover so the new tables
-- start clean.

SELECT 'chat_participants' AS source, chat_id, agent_id
  FROM chat_participants cp
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.uuid = cp.agent_id)
UNION ALL
SELECT 'chat_subscriptions' AS source, chat_id, agent_id
  FROM chat_subscriptions cs
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.uuid = cs.agent_id);

-- ──────────────────────────────────────────────────────────────────────
-- Probe 3: orphan chat_id references.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: 0 rows.
-- Both legacy tables have `ON DELETE CASCADE` on chat_id, so an orphan
-- chat_id should be impossible by construction. A non-zero result here
-- means the migration history is inconsistent and needs investigation
-- before back-filling.

SELECT 'chat_participants' AS source, chat_id, agent_id
  FROM chat_participants cp
 WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = cp.chat_id)
UNION ALL
SELECT 'chat_subscriptions' AS source, chat_id, agent_id
  FROM chat_subscriptions cs
 WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = cs.chat_id);

-- ──────────────────────────────────────────────────────────────────────
-- Probe 4: chats projection (last_message_at) drift.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: small number of rows (transient: the millisecond gap between
-- message INSERT and the projection UPDATE).
-- Large drift (> a few minutes, or chats with messages but NULL
-- last_message_at) indicates a stale projection — fix with a single
-- DISTINCT ON re-run before the migration so the cursor pagination in
-- the new listMeChats query plan does not surprise the user with
-- skipped chats.

SELECT
  c.id           AS chat_id,
  c.last_message_at AS chats_last_message_at,
  m.created_at   AS actual_latest_message_at,
  c.last_message_at - m.created_at AS drift
FROM chats c
JOIN LATERAL (
  SELECT created_at
    FROM messages
   WHERE chat_id = c.id
   ORDER BY created_at DESC
   LIMIT 1
) m ON true
WHERE c.last_message_at IS NULL
   OR ABS(EXTRACT(EPOCH FROM (c.last_message_at - m.created_at))) > 60
ORDER BY drift DESC NULLS LAST
LIMIT 100;

-- ──────────────────────────────────────────────────────────────────────
-- Row-count sanity (informational, not a gate).
-- ──────────────────────────────────────────────────────────────────────
-- Print expected back-fill volumes so the post-migration row-count
-- assertion inside 0038 has an external check.
--
-- `user_state_estimated_count` uses UNION (not SUM) over (chat_id,
-- agent_id) so a pair counted twice in both legacy tables — exactly the
-- collision Probe 1 hunts for — does NOT inflate the estimate. The
-- migration's speaker-wins merge collapses such pairs into a single
-- chat_user_state row, and this estimate must match that.

SELECT
  (SELECT COUNT(*) FROM chat_participants) AS participants_count,
  (SELECT COUNT(*) FROM chat_subscriptions) AS subscriptions_count,
  (SELECT COUNT(*)
     FROM (SELECT chat_id, agent_id FROM chat_participants
           UNION
           SELECT chat_id, agent_id FROM chat_subscriptions) u) AS union_count,
  (SELECT COUNT(*)
     FROM (SELECT chat_id, agent_id FROM chat_participants
            WHERE last_read_at IS NOT NULL OR unread_mention_count > 0
            UNION
           SELECT chat_id, agent_id FROM chat_subscriptions
            WHERE last_read_at IS NOT NULL OR unread_mention_count > 0) u)
    AS user_state_estimated_count;
