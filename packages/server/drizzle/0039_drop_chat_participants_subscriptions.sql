-- Chat data model restructure — Step 3 (drop legacy).
-- See proposals/chat-data-model-restructure.20260512.md §9.2 step 6
-- and §12.2 (catastrophic rollback boundary).
--
-- PR-B of the two-PR cutover. PR-A (#325, migration 0038) created
-- `chat_membership` + `chat_user_state` and back-filled them from
-- `chat_participants` + `chat_subscriptions`. The service layer has
-- been cutover to read/write only the new tables since PR-A. This
-- migration drops the legacy tables now that ≥1 workday of post-deploy
-- observation has passed without anomalies.
--
-- ROLLBACK is catastrophic post-this-migration: the legacy tables are
-- gone and require a backup-restore + re-run of 0038 to recover. This
-- is the explicit reason PR-A and PR-B were split — PR-A's reverse
-- migration is loss-free, PR-B's is not (§12.2). Do NOT merge this
-- before ops confirms PR-A stability.
--
-- Service-layer dependency check (run before merging):
--   git grep 'chat_participants\|chat_subscriptions' packages/server/src/
-- should return only doc / comment hits — any live query reference is
-- a blocker.

DROP TABLE IF EXISTS "chat_subscriptions";

--> statement-breakpoint
DROP TABLE IF EXISTS "chat_participants";
