-- Create users table (replaces admin_users)
CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "username" text NOT NULL,
  "password_hash" text NOT NULL,
  "display_name" text NOT NULL,
  "avatar_url" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_username_unique" UNIQUE("username")
);

-- Create members table
CREATE TABLE "members" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "agent_id" text NOT NULL REFERENCES "agents"("uuid"),
  "role" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "members_agent_id_unique" UNIQUE("agent_id"),
  CONSTRAINT "uq_members_user_org" UNIQUE("user_id", "organization_id")
);

CREATE INDEX "idx_members_user" ON "members" ("user_id");
CREATE INDEX "idx_members_org" ON "members" ("organization_id");

-- Add manager_id to agents with FK to members (FK in SQL only — not in Drizzle schema to avoid circular import)
ALTER TABLE "agents" ADD COLUMN "manager_id" text REFERENCES "members"("id") ON DELETE SET NULL;
CREATE INDEX "idx_agents_manager" ON "agents" ("manager_id");

-- Drop admin_users table
DROP TABLE "admin_users";
