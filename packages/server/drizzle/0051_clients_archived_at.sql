-- Soft-delete column for orphan-row archival.
--
-- - NULL → active row; surfaces in all read paths
--   (/me/clients, /orgs/:orgId/clients, GET /clients/:id, agent:bind joins).
-- - non-NULL → archived; excluded from read paths but the row stays for
--   audit / recovery. Set by the hourly archiveAbandonedClients sweep when
--   (status='disconnected', last_seen_at > 30d ago, zero pinned agents)
--   all hold. Cleared on reconnect by registerClient's same-id upsert.
--
-- Partial index idx_clients_sweep supports the sweep's WHERE clause:
-- (status, last_seen_at) leading keys line up with the equality + range
-- predicates; the `archived_at IS NULL` partial keeps the index lean as
-- archived rows accumulate.

-- Idempotent variants of ADD COLUMN / CREATE INDEX so the migration is
-- safe to re-apply on a DB where a partial of this change ran out-of-band
-- (e.g., manual schema repair). Drizzle's `__drizzle_migrations` table
-- already gates re-application; these guards are defense in depth.

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_clients_sweep" ON "clients" USING btree ("status","last_seen_at") WHERE archived_at IS NULL;
