-- Per-organization settings, keyed by (organization_id, namespace).
--
-- Each row holds an entire group of related config as a JSONB blob; the
-- schema for each namespace lives in @agent-team-foundation/first-tree-hub-shared
-- (ORG_SETTINGS_NAMESPACES) and is enforced by the service layer on every
-- read/write. Adding a new config group means registering a new namespace +
-- Zod schema in shared — the DB does not change.
--
-- `version` is reserved for future optimistic locking (PUT with If-Match).
-- We keep the column from day one so tightening to compare-and-swap later
-- is a code-only change with no migration.
--
-- Sensitive fields inside `value` (e.g. github_integration.webhookSecret)
-- are AES-256-GCM-encrypted at the service layer using crypto.ts's
-- encryptValue / decryptValue — same pattern as adapter_configs.
--
-- ON DELETE CASCADE on organization_id: settings have no independent
-- lifecycle, deleting an org must drop them. updated_by is SET NULL so a
-- user deletion does not cascade-clobber unrelated config rows.

CREATE TABLE IF NOT EXISTS "organization_settings" (
  "organization_id" text NOT NULL,
  "namespace"       text NOT NULL,
  "value"           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version"         integer NOT NULL DEFAULT 0,
  "updated_by"      text,
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("organization_id", "namespace"),
  CONSTRAINT "organization_settings_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_settings_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_org_settings_namespace"
  ON "organization_settings" ("namespace");
