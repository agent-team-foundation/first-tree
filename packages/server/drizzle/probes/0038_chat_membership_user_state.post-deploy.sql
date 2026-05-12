-- Post-deploy validation for migration 0038_chat_membership_user_state.
--
-- Run AFTER 0038 has been applied (staging first, then prod). The
-- migration itself has embedded row-count assertions that abort if the
-- back-fill diverges from the source legacy tables — these probes are a
-- second-pass *external* check (the migration's assertions ran inside
-- the same transaction; these run from outside).
--
-- HOW to run (read-only, safe to repeat):
--   psql "$DATABASE_URL" -f packages/server/drizzle/probes/0038_chat_membership_user_state.post-deploy.sql > 0038.post-deploy.<env>.txt
--
-- WHAT to look for: see the comment above each check.

-- ──────────────────────────────────────────────────────────────────────
-- Check 1: chat_membership row count matches UNION over legacy tables.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: `delta = 0`. A non-zero value means the back-fill dropped or
-- duplicated rows. The migration's own assertion should have caught this
-- inside the migration TX, so a non-zero here implies post-migration
-- divergence — somewhere a service is writing to one set of tables but
-- not the other (legacy tables still exist; PR-B drops them).

SELECT
  (SELECT COUNT(*) FROM chat_membership) AS membership_count,
  (SELECT COUNT(*)
     FROM (SELECT chat_id, agent_id FROM chat_participants
           UNION
           SELECT chat_id, agent_id FROM chat_subscriptions) u) AS legacy_union_count,
  (SELECT COUNT(*) FROM chat_membership)
    - (SELECT COUNT(*)
         FROM (SELECT chat_id, agent_id FROM chat_participants
               UNION
               SELECT chat_id, agent_id FROM chat_subscriptions) u) AS delta;

-- ──────────────────────────────────────────────────────────────────────
-- Check 2: chat_user_state row count matches UNION over legacy rows
-- that carry non-default state.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: `delta = 0`. Same rationale as Check 1, narrowed to the
-- state-carrying subset.

SELECT
  (SELECT COUNT(*) FROM chat_user_state) AS user_state_count,
  (SELECT COUNT(*)
     FROM (SELECT chat_id, agent_id FROM chat_participants
            WHERE last_read_at IS NOT NULL OR unread_mention_count > 0
            UNION
           SELECT chat_id, agent_id FROM chat_subscriptions
            WHERE last_read_at IS NOT NULL OR unread_mention_count > 0) u)
    AS legacy_state_union_count,
  (SELECT COUNT(*) FROM chat_user_state)
    - (SELECT COUNT(*)
         FROM (SELECT chat_id, agent_id FROM chat_participants
                WHERE last_read_at IS NOT NULL OR unread_mention_count > 0
                UNION
               SELECT chat_id, agent_id FROM chat_subscriptions
                WHERE last_read_at IS NOT NULL OR unread_mention_count > 0) u)
    AS delta;

-- ──────────────────────────────────────────────────────────────────────
-- Check 3: speaker-wins merge preserved on collision.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: 0 rows.
-- For every (chat_id, agent_id) pair that appears in BOTH legacy tables,
-- the resulting chat_membership row MUST be access_mode='speaker' (per
-- migration 0038's "DO NOTHING on the subscription branch" merge policy).
-- A non-zero result means the merge policy was violated.

SELECT cp.chat_id, cp.agent_id, cm.access_mode
  FROM chat_participants cp
  JOIN chat_subscriptions cs USING (chat_id, agent_id)
  JOIN chat_membership cm ON cm.chat_id = cp.chat_id AND cm.agent_id = cp.agent_id
 WHERE cm.access_mode <> 'speaker';

-- ──────────────────────────────────────────────────────────────────────
-- Check 4: listMeChats query plan uses the new indexes.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: the plan should reference at least one of
--   - `chat_membership_pkey` (PK on chat_id, agent_id) for the JOIN
--   - `idx_membership_agent` for the cm.agent_id filter
--   - `idx_user_state_agent` for the cus LEFT JOIN
-- A plan that falls back to a Seq Scan on `chat_membership` or
-- `chat_user_state` is a regression — the row counts on staging may be
-- low enough for the planner to *prefer* a seq scan, in which case re-run
-- with a known-active human agent that has many chats.
--
-- Replace `__AGENT_ID__` with a real human agent uuid and `__ORG_ID__`
-- with that agent's manager.organization_id, both from staging.

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
  c.id                  AS chat_id,
  c.type                AS type,
  c.topic               AS topic,
  c.parent_chat_id      AS parent_chat_id,
  c.last_message_at     AS last_message_at,
  c.last_message_preview AS last_message_preview,
  (SELECT count(*) FROM chat_membership
    WHERE chat_id = c.id AND access_mode = 'speaker') AS participant_count,
  cm.access_mode AS access_mode,
  COALESCE(cus.unread_mention_count, 0) AS unread_mention_count
  FROM chats c
  JOIN chat_membership cm
    ON cm.chat_id = c.id AND cm.agent_id = '__AGENT_ID__'
  LEFT JOIN chat_user_state cus
    ON cus.chat_id = c.id AND cus.agent_id = '__AGENT_ID__'
 WHERE c.parent_chat_id IS NULL
   AND c.organization_id = '__ORG_ID__'
 ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
 LIMIT 21;

-- ──────────────────────────────────────────────────────────────────────
-- Check 5: index scan stats since deploy.
-- ──────────────────────────────────────────────────────────────────────
-- Informational — run a few hours after traffic resumes. The new indexes
-- should have non-zero `idx_scan` counts (proving the planner does pick
-- them); zero scans means the planner is bypassing them entirely.

SELECT relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
  FROM pg_stat_user_indexes
 WHERE indexrelname IN (
     'chat_membership_pkey',
     'idx_membership_agent',
     'idx_membership_chat_role',
     'chat_user_state_pkey',
     'idx_user_state_agent',
     'idx_user_state_unread'
   )
 ORDER BY indexrelname;

-- ──────────────────────────────────────────────────────────────────────
-- Check 6: unread badge consistency with listMeChats scope.
-- ──────────────────────────────────────────────────────────────────────
-- Expected: 0 rows.
-- For any human agent, the unread badge (countUnreadMeChats) and the
-- list view (listMeChats) must agree — both must JOIN chat_membership +
-- chats and filter by parent_chat_id IS NULL + organization_id. A
-- chat_user_state row whose owner has been fully detached (no
-- chat_membership row) is allowed (preserved-on-detach per design
-- §11.4), but it must NOT contribute to the badge.
--
-- Replace `__AGENT_ID__` + `__ORG_ID__` as in Check 4. The output is
-- the count surfaced to the badge minus the count of unread chats the
-- list view would actually show; both must match.

WITH badge AS (
  SELECT count(*)::int AS n
    FROM chat_user_state cus
    JOIN chat_membership cm ON cm.chat_id = cus.chat_id AND cm.agent_id = cus.agent_id
    JOIN chats c            ON c.id = cus.chat_id
   WHERE cus.agent_id = '__AGENT_ID__'
     AND cus.unread_mention_count > 0
     AND c.parent_chat_id IS NULL
     AND c.organization_id = '__ORG_ID__'
), list AS (
  SELECT count(*)::int AS n
    FROM chats c
    JOIN chat_membership cm ON cm.chat_id = c.id AND cm.agent_id = '__AGENT_ID__'
    LEFT JOIN chat_user_state cus ON cus.chat_id = c.id AND cus.agent_id = '__AGENT_ID__'
   WHERE c.parent_chat_id IS NULL
     AND c.organization_id = '__ORG_ID__'
     AND COALESCE(cus.unread_mention_count, 0) > 0
)
SELECT badge.n AS badge_count, list.n AS list_count, badge.n - list.n AS delta
  FROM badge, list;
