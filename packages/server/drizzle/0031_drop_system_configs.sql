-- Drop the `system_configs` table — replaced by deployment-level env
-- vars (FIRST_TREE_INBOX_TIMEOUT_SECONDS, FIRST_TREE_MAX_RETRY_COUNT,
-- FIRST_TREE_POLLING_INTERVAL_SECONDS, FIRST_TREE_PRESENCE_CLEANUP_SECONDS,
-- FIRST_TREE_NOTIFICATION_WEBHOOK_URL).
--
-- See proposals/hub-strip-jwt-ambient-scope.20260508.md §3.5 + §6.3.
-- The table held tunables that were never customer-configurable; promoting
-- them to env vars closes the multi-tenant security gap where any org admin
-- could mutate cross-org runtime behavior.

DROP TABLE IF EXISTS "system_configs";
