-- Agent identity refactoring: id → uuid (PK) + name (human-readable, per-org unique)
-- Run BEFORE the data migration script (scripts/migrate-uuid.ts).

-- 1. Add name column
ALTER TABLE "agents" ADD COLUMN "name" text;

-- 2. Rename id → uuid (PG auto-updates FK constraints referencing this column)
ALTER TABLE "agents" RENAME COLUMN "id" TO "uuid";

-- 3. Add composite unique constraint (org + name)
-- NULLs are distinct in PG unique constraints, so deleted agents (name=NULL) don't conflict
ALTER TABLE "agents" ADD CONSTRAINT "uq_agents_org_name" UNIQUE("organization_id", "name");
