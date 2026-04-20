-- Unified user token milestone — retire agent tokens, authenticate every
-- caller as a user.
--
-- This migration collapses the two-track auth (member JWT + `aghub_*` agent
-- token) into a single member-JWT credential. Three structural changes:
--   1. Drop `agent_tokens` (table + FK cascade).
--   2. Add `clients.user_id` (nullable) — owning user of the physical client.
--   3. Add `agents.client_id` (nullable FK) — pin an agent to the client that
--      runs it. `client_id` is backfilled from `agent_presence`. Rows that
--      cannot be backfilled stay NULL and bind on first WS connect (see
--      `api/agent/ws-client.ts` first-bind path). Originally this migration
--      raised an exception when any non-human agent was unbacked — that
--      gated startup on a data state the operator usually can't fix until
--      the server is up. Relaxed to NOTICE so the loop is broken; runtime
--      enforcement (Rule R-RUN in `services/agent.ts` + `agent-selector.ts`)
--      still rejects unclaimed agents on the request path.
--   4. Make `agents.manager_id` NOT NULL after backfilling the first admin
--      member of each org onto the unmanaged rows.
--
-- There is no compatibility layer: operators stop SDK/CLI processes, run
-- `db:migrate`, then re-login via `first-tree-hub connect`. See the proposal
-- "unified-user-token.20260417" for the full upgrade runbook.
--
-- NOTE: Do NOT wrap this file in BEGIN;/COMMIT;. The Drizzle migrator already
-- runs every pending migration inside a single outer transaction, so a nested
-- BEGIN raises WARNING 25001 and the inner COMMIT prematurely closes the
-- outer transaction — which prevents the migration hash from being recorded
-- and causes the server to loop through the same failure on every restart.

DROP TABLE IF EXISTS "agent_tokens";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- clients.user_id — nullable FK to users(id).
-- Nullable so legacy rows (created before handshake auth) keep existing;
-- the WS handshake claims them on first re-register under a JWT.
-- ---------------------------------------------------------------------------
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_clients_user" ON "clients" ("user_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- agents.client_id — pin an agent to the physical client that runs it.
-- ---------------------------------------------------------------------------
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "client_id" text REFERENCES "clients"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- Copy last-bound client from agent_presence.
UPDATE "agents" a
SET "client_id" = ap."client_id"
FROM "agent_presence" ap
WHERE ap."agent_id" = a."uuid"
  AND ap."client_id" IS NOT NULL
  AND a."client_id" IS NULL;
--> statement-breakpoint

-- Surface (do not block) any non-deleted non-human agent still missing a
-- client_id after the backfill. They will sit in an "unclaimed" state until
-- a client connects via WS and the first-bind path in
-- `api/agent/ws-client.ts` claims them. Runtime guards reject HTTP / WS
-- requests for those agents in the meantime.
DO $$
DECLARE
  unpinned_count integer;
BEGIN
  SELECT COUNT(*) INTO unpinned_count
  FROM "agents"
  WHERE "client_id" IS NULL
    AND "type" <> 'human'
    AND "status" <> 'deleted';

  IF unpinned_count > 0 THEN
    RAISE NOTICE
      'unified-user-token migration: % non-human agents have no client_id after backfill; '
      'they will be claimed on first WS bind (see ws-client.ts first-bind path)',
      unpinned_count;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agents_client" ON "agents" ("client_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- agents.manager_id — backfill then enforce NOT NULL.
-- Human agents own their members row, so self-assign via members.
-- Non-human agents get the first admin member in their org.
-- ---------------------------------------------------------------------------

-- Human agents: self-assign to their own member row.
UPDATE "agents" a
SET "manager_id" = m."id"
FROM "members" m
WHERE m."agent_id" = a."uuid"
  AND a."manager_id" IS NULL
  AND a."type" = 'human';
--> statement-breakpoint

-- Non-human agents: first admin in org, ordered by created_at asc.
UPDATE "agents" a
SET "manager_id" = m."id"
FROM (
  SELECT DISTINCT ON (m."organization_id")
    m."id" AS id,
    m."organization_id" AS organization_id
  FROM "members" m
  WHERE m."role" = 'admin'
  ORDER BY m."organization_id", m."created_at" ASC
) m
WHERE a."organization_id" = m."organization_id"
  AND a."manager_id" IS NULL;
--> statement-breakpoint

-- Fail loudly if any agent still lacks a manager.
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "agents"
  WHERE "manager_id" IS NULL
    AND "status" <> 'deleted';

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'unified-user-token migration: % non-deleted agents have no manager_id after backfill; '
      'create at least one admin member per org, or set agents.manager_id manually, then retry',
      orphan_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "agents"
  ALTER COLUMN "manager_id" SET NOT NULL;
--> statement-breakpoint

-- Recreate the manager_id FK as DEFERRABLE INITIALLY DEFERRED so the
-- bootstrap path for a new human agent + member row can run inside a
-- single transaction. The two rows reference each other (agents.manager_id
-- → members.id, members.agent_id → agents.uuid); without deferred FKs the
-- first INSERT always fails the sibling constraint.
ALTER TABLE "agents"
  DROP CONSTRAINT IF EXISTS "agents_manager_id_fkey";
--> statement-breakpoint

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_manager_id_fkey"
  FOREIGN KEY ("manager_id") REFERENCES "members"("id")
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
