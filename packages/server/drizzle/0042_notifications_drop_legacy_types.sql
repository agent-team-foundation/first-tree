-- Drop notification rows whose `type` is no longer in the shared schema.
--
-- Three types were removed in earlier work but their rows were left behind:
--
--   * `agent_disconnected` — producer deleted by PR #348 (the
--     systemctl-restart spam fix), schema enum entry deleted later. 37 rows
--     still in dev hub at the time of writing, with no UI label and no
--     click target.
--   * `session_completed` — removed end-to-end in this PR (was 56% of recent
--     notifications, duplicating the conversation list's "latest message"
--     signal). Without the cleanup, the bell would keep surfacing them
--     until each org's user marks them all read manually.
--   * `session_error` — long-dead type: schema entry + UI label existed,
--     but no producer ever wrote one. Cleanup is defensive — any stray
--     rows from a hand-written test or prod-DB experiment go.
--
-- `notifications.type` is a `text` column (not a PG enum), so this is a
-- pure data-cleanup migration — no schema change, no type-cast risk.
--
-- The unread-only branch handles the transition window for rows still on
-- the previous per-type dedup key (`agent:{id}:agent_error|blocked|stale`).
-- They co-exist with new `agent:{id}:fault` rows for the same agent until
-- one or the other is marked read, which is exactly the redundancy this PR
-- is fixing — so wipe them too. Read rows on those keys stay (history).

DELETE FROM "notifications"
WHERE "type" IN ('agent_disconnected', 'session_completed', 'session_error');

DELETE FROM "notifications"
WHERE "read" = false
  AND "dedup_key" IN (
    SELECT "dedup_key" FROM "notifications"
    WHERE "dedup_key" LIKE 'agent:%:agent_error'
       OR "dedup_key" LIKE 'agent:%:agent_blocked'
       OR "dedup_key" LIKE 'agent:%:agent_stale'
  );
