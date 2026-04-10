-- Organization UUID PK: add name column with unique constraint, drop old defaults

-- Step 1: Add name column
ALTER TABLE "organizations" ADD COLUMN "name" text;
--> statement-breakpoint

-- Step 2: Backfill name from id for existing rows
UPDATE "organizations" SET "name" = "id" WHERE "name" IS NULL;
--> statement-breakpoint

-- Step 3: Make name NOT NULL
ALTER TABLE "organizations" ALTER COLUMN "name" SET NOT NULL;
--> statement-breakpoint

-- Step 4: Add UNIQUE constraint on name
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_name_unique" UNIQUE("name");
--> statement-breakpoint

-- Step 5: Drop old default values on organization_id columns (was 'default' slug)
ALTER TABLE "agents" ALTER COLUMN "organization_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "organization_id" DROP DEFAULT;
