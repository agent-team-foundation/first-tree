-- GitHub App installation registry. See packages/server/src/db/schema/github-app-installations.ts
-- for the Drizzle types, and docs/github-app-design-zh.md for the design rationale.
--
-- One row per (GitHub account ↔ Hub team) binding. Replaces the per-repo
-- OAuth + webhook-secret model that lived in
-- `organization_settings.github_integration.webhookSecretCipher` — both
-- coexist during the transition, the old path is dropped in a later PR
-- (D3 hard cut, design doc §7 step 7).
--
-- Per the team's "integrity in service layer" convention, NO foreign-key
-- constraints on hub_organization_id beyond the optional reference — the
-- 1:1 binding (D2 / §8 Q1) is enforced by a UNIQUE INDEX rather than by
-- ON DELETE CASCADE so deleting a Hub org doesn't tombstone the
-- GitHub-side record (which still exists upstream).

CREATE TABLE IF NOT EXISTS "github_app_installations" (
  "id" text PRIMARY KEY NOT NULL,
  "installation_id" bigint NOT NULL,
  "account_type" text NOT NULL,
  "account_login" text NOT NULL,
  "account_github_id" bigint NOT NULL,
  "hub_organization_id" text,
  "permissions" jsonb NOT NULL,
  "events" jsonb NOT NULL,
  "suspended_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_github_app_installations_account_type"
    CHECK ("account_type" IN ('User', 'Organization'))
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "github_app_installations"
    ADD CONSTRAINT "github_app_installations_hub_organization_id_organizations_id_fk"
    FOREIGN KEY ("hub_organization_id") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_github_app_installations_installation_id"
  ON "github_app_installations" ("installation_id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_github_app_installations_hub_org"
  ON "github_app_installations" ("hub_organization_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_app_installations_account"
  ON "github_app_installations" ("account_github_id");
