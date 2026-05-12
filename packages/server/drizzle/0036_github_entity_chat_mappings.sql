-- GitHub webhook → chat clustering (Phase 0).
-- Maps every (organization, human_agent, delegate_agent, entity) tuple to a
-- single chat. Replaces the legacy "one (human, delegate) chat absorbs every
-- GitHub event" behaviour — see docs webhook-routing-design.md §4 for the
-- background and §4.3 for the data-model decision.
--
-- The composite primary key is also the uniqueness constraint we rely on for
-- concurrent webhook safety: two near-simultaneous events for a brand-new
-- entity hit ON CONFLICT DO NOTHING and the second deliverer falls back to a
-- re-SELECT, so the pair never spawns duplicate chats.
--
-- ON DELETE CASCADE on agent / chat columns: a deleted agent or chat must
-- drop its mapping rows. We do NOT cascade from organizations because that
-- relationship is enforced via the agent FKs already.
--
-- This table is GitHub-specific. Future external sources (Linear, Slack
-- channel events, …) get their own table — their entity models differ
-- enough that a generic table would slide back into untyped jsonb.
--
-- Migration 0036 is hand-written to match the team's recent migration
-- workflow — drizzle-kit generate's snapshot metadata is incomplete pre-0019
-- and refuses to diff (same constraint that 0032's commit message called out).

CREATE TABLE IF NOT EXISTS "github_entity_chat_mappings" (
  "organization_id"    text NOT NULL,
  "human_agent_id"     text NOT NULL,
  "delegate_agent_id"  text NOT NULL,
  "entity_type"        text NOT NULL,
  "entity_key"         text NOT NULL,
  "chat_id"            text NOT NULL,
  "bound_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "bound_via"          text NOT NULL,
  CONSTRAINT "github_entity_chat_mappings_pkey"
    PRIMARY KEY ("organization_id", "human_agent_id", "delegate_agent_id", "entity_type", "entity_key"),
  CONSTRAINT "github_entity_chat_mappings_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id"),
  CONSTRAINT "github_entity_chat_mappings_human_agent_id_agents_uuid_fk"
    FOREIGN KEY ("human_agent_id") REFERENCES "agents"("uuid") ON DELETE CASCADE,
  CONSTRAINT "github_entity_chat_mappings_delegate_agent_id_agents_uuid_fk"
    FOREIGN KEY ("delegate_agent_id") REFERENCES "agents"("uuid") ON DELETE CASCADE,
  CONSTRAINT "github_entity_chat_mappings_chat_id_chats_id_fk"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_entity_chat_mappings_chat"
  ON "github_entity_chat_mappings" ("chat_id");
