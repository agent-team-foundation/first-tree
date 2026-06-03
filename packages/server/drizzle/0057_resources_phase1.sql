-- Resources Phase 1.
--
-- Hand-authored to match the existing manual migration precedent in this
-- repository. Service-layer schemas enforce type-specific payload and binding
-- invariants; SQL owns storage shape and repo canonical-key uniqueness.

CREATE TABLE IF NOT EXISTS "resources" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "type" text NOT NULL,
  "scope" text NOT NULL,
  "owner_agent_id" text REFERENCES "agents"("uuid") ON DELETE cascade,
  "name" text NOT NULL,
  "repo_canonical_key" text,
  "default_enabled" text,
  "status" text NOT NULL DEFAULT 'active',
  "payload" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resources_org_type_scope"
  ON "resources" ("organization_id", "type", "scope");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resources_owner_agent"
  ON "resources" ("owner_agent_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resources_repo_key"
  ON "resources" ("organization_id", "repo_canonical_key");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_resources_team_repo_canonical_active"
  ON "resources" ("organization_id", "repo_canonical_key")
  WHERE "type" = 'repo'
    AND "scope" = 'team'
    AND "status" IN ('active', 'stale')
    AND "repo_canonical_key" IS NOT NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_resources_agent_repo_canonical_active"
  ON "resources" ("organization_id", "owner_agent_id", "repo_canonical_key")
  WHERE "type" = 'repo'
    AND "scope" = 'agent'
    AND "status" IN ('active', 'stale')
    AND "repo_canonical_key" IS NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_resource_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "agent_id" text NOT NULL REFERENCES "agents"("uuid") ON DELETE cascade,
  "type" text NOT NULL,
  "mode" text NOT NULL,
  "resource_id" text REFERENCES "resources"("id") ON DELETE cascade,
  "replaces_resource_id" text REFERENCES "resources"("id") ON DELETE cascade,
  "inline_prompt_body" text,
  "repo_ref" text,
  "repo_local_path" text,
  "order" integer NOT NULL DEFAULT 0,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_resource_bindings_agent"
  ON "agent_resource_bindings" ("agent_id", "type");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_resource_bindings_resource"
  ON "agent_resource_bindings" ("resource_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_resource_bindings_replaces"
  ON "agent_resource_bindings" ("replaces_resource_id");
