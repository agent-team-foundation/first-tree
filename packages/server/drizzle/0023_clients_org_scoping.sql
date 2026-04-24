-- Multi-tenancy hardening:
--   1. Drop dead column `agents.cloud_user_id` (unused since introduction in
--      0010; never written by any code path).
--   2. Bind every client to exactly one organization via `clients.organization_id`.
--
-- A client is bound to one org for its lifetime — Rule R-RUN and the
-- `client:register` handshake reject cross-org reuse of a clientId. See
-- docs/multi-tenancy-hardening-design.md.
--
-- Backfill strategy (guarded for safety across environments):
--   * Current production: exactly one org → UPDATE fills every row.
--   * Fresh installs / empty DB: clients table is empty → UPDATE is a no-op,
--     SET NOT NULL succeeds on the empty table.
--   * Any environment reaching this migration with multi-org data but
--     unpopulated clients.organization_id: the guard skips the UPDATE, and
--     SET NOT NULL fails loudly rather than misassigning rows to an
--     arbitrary org. Operator must backfill manually, then re-run.

ALTER TABLE "agents" DROP COLUMN "cloud_user_id";

--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "organization_id" text;

--> statement-breakpoint
ALTER TABLE "clients"
	ADD CONSTRAINT "clients_organization_id_organizations_id_fk"
	FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
	ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
UPDATE "clients"
SET "organization_id" = (SELECT "id" FROM "organizations" LIMIT 1)
WHERE "organization_id" IS NULL
	AND (SELECT count(*) FROM "organizations") = 1;

--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "organization_id" SET NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_clients_org" ON "clients" ("organization_id");
