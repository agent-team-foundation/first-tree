-- Cloud Multi-Tenancy Phase 1: organizations table + agents/chats FK + new agent fields

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS "organizations" (
  "id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "max_agents" integer NOT NULL DEFAULT 0,
  "max_messages_per_minute" integer NOT NULL DEFAULT 0,
  "features" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- 2. Insert default organization (idempotent — skip if exists)
INSERT INTO "organizations" ("id", "display_name")
VALUES ('default', 'Default Organization')
ON CONFLICT ("id") DO NOTHING;

-- 3. Add FK from agents.organization_id → organizations.id
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 4. Add FK from chats.organization_id → organizations.id
ALTER TABLE "chats"
  ADD CONSTRAINT "chats_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 5. Add new columns to agents
ALTER TABLE "agents" ADD COLUMN "source" text;
ALTER TABLE "agents" ADD COLUMN "cloud_user_id" text;
ALTER TABLE "agents" ADD COLUMN "public" boolean NOT NULL DEFAULT false;
