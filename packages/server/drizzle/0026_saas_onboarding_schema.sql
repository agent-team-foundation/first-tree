-- SaaS onboarding schema (M0).
--
-- Adds the four data-model pieces the SaaS onboarding journey depends on:
--
--   1. users.email — primary contact email. Sourced from the GitHub OAuth
--      provider on SaaS signup; legacy self-hosted rows have no email today,
--      so we backfill a per-row `<id>@noreply.local` placeholder before
--      adding NOT NULL + UNIQUE. The placeholder keeps the column populated
--      without surfacing a fake address — when a self-hosted user later
--      links GitHub via OAuth the real address takes over (PR #2).
--   2. auth_providers — third-party identity binding. One row per
--      (provider, provider_user_id) pointing at users.id. PR #2 will write
--      to it on the GitHub callback path.
--   3. organizations.invite_token + invite_token_created_at — per-workspace
--      public share-link token (url-safe base64, 32 random bytes). Existing
--      rows are backfilled with random tokens before NOT NULL + UNIQUE.
--      Requires pgcrypto for `gen_random_bytes`.
--   4. members.onboarding_state — nullable JSONB tracking wizard checkpoint
--      per (user × workspace). Null for existing self-hosted rows; new SaaS
--      members start at "connect" / "create_agent" / "completed".
--
-- See docs/saas-onboarding-journey.md §5 for the field-level rationale.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;

--> statement-breakpoint
UPDATE "users"
   SET "email" = "id" || '@noreply.local'
 WHERE "email" IS NULL;

--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "users"
	ADD CONSTRAINT "users_email_unique" UNIQUE ("email");

--> statement-breakpoint
CREATE TABLE "auth_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email_at_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_auth_providers_provider_user" UNIQUE ("provider", "provider_user_id")
);

--> statement-breakpoint
ALTER TABLE "auth_providers"
	ADD CONSTRAINT "auth_providers_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "users"("id")
	ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_providers_user"
	ON "auth_providers" ("user_id");

--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "invite_token" text;

--> statement-breakpoint
ALTER TABLE "organizations"
	ADD COLUMN "invite_token_created_at" timestamp with time zone DEFAULT now() NOT NULL;

--> statement-breakpoint
-- Backfill: url-safe base64 of 32 random bytes, padding stripped. `gen_random_bytes`
-- is volatile so each row evaluates independently — no collisions in practice.
UPDATE "organizations"
   SET "invite_token" = rtrim(
       replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'),
       '='
     )
 WHERE "invite_token" IS NULL;

--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "invite_token" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "organizations"
	ADD CONSTRAINT "organizations_invite_token_unique" UNIQUE ("invite_token");

--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "onboarding_state" jsonb;
