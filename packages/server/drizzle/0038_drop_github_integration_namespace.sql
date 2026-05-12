-- D3 cutover follow-up: drop residual per-org webhook config from
-- `organization_settings`. Background: docs/github-app-design-zh.md §7
-- step 7. The GitHub App webhook endpoint now uses a single
-- deployment-level secret (`FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET`)
-- and per-org binding lives in `github_app_installations`, so the
-- legacy `github_integration` namespace rows are dead data.
--
-- No CREATE/DROP TABLE — `organization_settings` is the generic
-- (orgId, namespace) → JSONB store; deleting a namespace is a data
-- cleanup, not a schema change. The shared `ORG_SETTINGS_NAMESPACES`
-- registry was already trimmed in the same commit, so any code path
-- still trying to read or write `github_integration` will fail at the
-- service layer before reaching the DB.

DELETE FROM "organization_settings" WHERE "namespace" = 'github_integration';
