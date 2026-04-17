-- Unified user token milestone — retire agent tokens, authenticate every
-- caller as a user.
--
-- This migration collapses the two-track auth (member JWT + `aghub_*` agent
-- token) into a single member-JWT credential. Three structural changes:
--   1. Drop `agent_tokens` (table + FK cascade).
--   2. Add `clients.user_id` (nullable) — owning user of the physical client.
--   3. Add `agents.client_id` (nullable FK) — pin an agent to the client that
--      runs it. `client_id` is backfilled from `agent_presence` and is
--      required for every non-human agent (enforced in the service layer per
--      CLAUDE.md "integrity in service layer"; no DB CHECK/trigger).
--   4. Make `agents.manager_id` NOT NULL after backfilling the first admin
--      member of each org onto the unmanaged rows.
--
-- There is no compatibility layer: operators stop SDK/CLI processes, run
-- `db:migrate`, then re-login via `first-tree-hub connect`. See the proposal
-- "unified-user-token.20260417" for the full upgrade runbook.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop agent_tokens (FK cascade handles row removal).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "agent_tokens";

-- ---------------------------------------------------------------------------
-- 2. clients.user_id — nullable FK to users(id).
--    Nullable so legacy rows (created before handshake auth) keep existing;
--    the WS handshake claims them on first re-register under a JWT.
-- ---------------------------------------------------------------------------
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_clients_user" ON "clients" ("user_id");

-- ---------------------------------------------------------------------------
-- 3. agents.client_id — pin an agent to the physical client that runs it.
--    Backfill in two steps:
--      a. Copy the most recent bind from agent_presence, if any.
--      b. For non-human agents with no bind history, attempt to pick the
--         first client in the agent's org. If none exists we intentionally
--         leave the row NULL; the service layer refuses runtime bind while
--         `client_id IS NULL` so operators notice and fix it.
-- ---------------------------------------------------------------------------
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "client_id" text REFERENCES "clients"("id") ON DELETE RESTRICT;

-- 3a. Copy last-bound client from agent_presence.
UPDATE "agents" a
SET "client_id" = ap."client_id"
FROM "agent_presence" ap
WHERE ap."agent_id" = a."uuid"
  AND ap."client_id" IS NOT NULL
  AND a."client_id" IS NULL;

-- 3b. Fail loudly if any non-deleted non-human agent is missing a client_id
--     after 3a. These rows would pass migration but surface at runtime as
--     `WRONG_CLIENT` / `assertClientOwner` 404 — which looks like "installed
--     but broken" to the operator. Mirrors 4c's orphan-count pattern. Admins
--     must either soft-delete the orphans or re-register their client via
--     `first-tree-hub connect` and manually UPDATE before retrying.
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
    RAISE EXCEPTION
      'unified-user-token migration: % non-human agents have no client_id after backfill; '
      're-register their client via `first-tree-hub connect` (which will update agent_presence) '
      'or soft-delete the orphan agents, then retry',
      unpinned_count;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_agents_client" ON "agents" ("client_id");

-- ---------------------------------------------------------------------------
-- 4. agents.manager_id — backfill then enforce NOT NULL.
--    Human agents own their members row, so self-assign via members.
--    Non-human agents get the first admin member in their org.
-- ---------------------------------------------------------------------------

-- 4a. Human agents: self-assign to their own member row.
UPDATE "agents" a
SET "manager_id" = m."id"
FROM "members" m
WHERE m."agent_id" = a."uuid"
  AND a."manager_id" IS NULL
  AND a."type" = 'human';

-- 4b. Non-human agents: first admin in org, ordered by created_at asc.
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

-- 4c. Fail loudly if any agent still lacks a manager. Admin must intervene
--     before the migration can complete.
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

ALTER TABLE "agents"
  ALTER COLUMN "manager_id" SET NOT NULL;

-- 4d. Recreate the manager_id FK as DEFERRABLE INITIALLY DEFERRED so the
--     bootstrap path for a new human agent + member row can run inside a
--     single transaction. The two rows reference each other (agents.manager_id
--     → members.id, members.agent_id → agents.uuid); without deferred FKs the
--     first INSERT always fails the sibling constraint. Manager reassignment
--     (member.ts::deleteMember) also benefits: we can move every agent in one
--     pass without fighting constraint order.
ALTER TABLE "agents"
  DROP CONSTRAINT IF EXISTS "agents_manager_id_fkey";
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_manager_id_fkey"
  FOREIGN KEY ("manager_id") REFERENCES "members"("id")
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
