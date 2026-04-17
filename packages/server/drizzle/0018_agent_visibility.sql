-- Replace boolean "public" column with text "visibility" column
ALTER TABLE "agents" ADD COLUMN "visibility" text NOT NULL DEFAULT 'private';--> statement-breakpoint

-- Set defaults by agent type
UPDATE "agents" SET "visibility" = 'organization' WHERE "type" = 'human';--> statement-breakpoint
UPDATE "agents" SET "visibility" = 'organization' WHERE "type" = 'autonomous_agent';--> statement-breakpoint
UPDATE "agents" SET "visibility" = 'private' WHERE "type" = 'personal_assistant';--> statement-breakpoint

-- Drop old public column
ALTER TABLE "agents" DROP COLUMN "public";--> statement-breakpoint

-- Add index for visibility queries
CREATE INDEX "idx_agents_visibility_org" ON "agents" USING btree ("organization_id","visibility");
