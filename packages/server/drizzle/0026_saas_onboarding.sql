-- SaaS onboarding milestone — adds the data-model surface needed for
-- public GitHub-OAuth signup, per-org invitation links, and "leave team"
-- soft-delete. See proposals/hub-saas-onboarding.20260428.md for the full
-- design contract.
--
-- Three independent additions, no destructive changes to existing tables:
--
--   1. `auth_identities` — third-party / local auth identities for a user.
--      Models the "how does this user prove who they are" boundary.
--      `(provider, identifier)` is globally unique. v1 stores the credential
--      payload (password hash, webauthn pubkey) on the same row;
--      v2 splits it into `auth_credentials` if multi-factor is needed
--      (the migration is sketched in the schema file's header comment).
--
--   2. `invitations` + `invitation_redemptions` — org-level share links.
--      The "one active link per org" rule is enforced by a partial UNIQUE
--      index (Drizzle's TS DSL doesn't model partial uniques yet, so we
--      add it directly here). Rotation = revoke prior + insert new in a
--      single transaction. Redemptions are recorded for audit.
--
--   3. `members.status` — "active" | "left" soft-delete marker for the
--      "leave team" flow. Existing rows backfill to "active" via the
--      column DEFAULT. The auth middleware rejects tokens that resolve to
--      a "left" member; join-by-invite flips a "left" row back to "active".
--
-- All three changes are append-only (new tables + new column with DEFAULT).
-- ALTER TABLE on `members` takes a brief ACCESS EXCLUSIVE lock, which is
-- safe on a v1 SaaS members table (small) but should be benchmarked on a
-- large multi-tenant install before rolling.
--
-- See 0020_unified_user_token.sql header for why this file does NOT wrap in
-- BEGIN;/COMMIT; — Drizzle migrator already runs every pending migration
-- inside a single outer transaction.

-- ---------------------------------------------------------------------------
-- 1. auth_identities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "auth_identities" (
	"id"                  text PRIMARY KEY NOT NULL,
	"user_id"             text NOT NULL,
	"provider"            text NOT NULL,
	"identifier"          text NOT NULL,
	"email"               text,
	"verified_at"         timestamp with time zone,
	"credential_type"     text,
	"credential_payload"  jsonb,
	"metadata"            jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at"          timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at"          timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_auth_identities_provider_identifier" UNIQUE ("provider", "identifier")
);

--> statement-breakpoint
ALTER TABLE "auth_identities"
	ADD CONSTRAINT "auth_identities_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "users"("id")
	ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_identities_user" ON "auth_identities" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_identities_email" ON "auth_identities" ("email");

-- ---------------------------------------------------------------------------
-- 2. invitations + invitation_redemptions
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
	"id"               text PRIMARY KEY NOT NULL,
	"organization_id"  text NOT NULL,
	"token"            text NOT NULL UNIQUE,
	"role"             text DEFAULT 'member' NOT NULL,
	"expires_at"       timestamp with time zone,
	"revoked_at"       timestamp with time zone,
	"created_by"       text NOT NULL,
	"created_at"       timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "invitations"
	ADD CONSTRAINT "invitations_organization_id_organizations_id_fk"
	FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitations"
	ADD CONSTRAINT "invitations_created_by_users_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "users"("id")
	ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invitations_token" ON "invitations" ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invitations_org" ON "invitations" ("organization_id");

--> statement-breakpoint
-- v1 enforced rule: each org may have at most one non-revoked invitation.
-- The predicate is intentionally `revoked_at IS NULL` only — Postgres rejects
-- `now()` in an index predicate (must be IMMUTABLE), and conflating "expired"
-- with "no longer the active link" matches the v1 service contract anyway.
-- The runtime "is this still usable" filter (which DOES check `expires_at`)
-- lives in services/invitation.ts. Future "multiple links per org" relaxes by
-- dropping this index.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invitations_active_per_org"
	ON "invitations" ("organization_id")
	WHERE "revoked_at" IS NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitation_redemptions" (
	"id"             text PRIMARY KEY NOT NULL,
	"invitation_id"  text NOT NULL,
	"user_id"        text NOT NULL,
	"redeemed_at"    timestamp with time zone DEFAULT now() NOT NULL,
	"ip"             text,
	"user_agent"     text
);

--> statement-breakpoint
ALTER TABLE "invitation_redemptions"
	ADD CONSTRAINT "invitation_redemptions_invitation_id_invitations_id_fk"
	FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitation_redemptions"
	ADD CONSTRAINT "invitation_redemptions_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "users"("id")
	ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invitation_redemptions_invitation"
	ON "invitation_redemptions" ("invitation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invitation_redemptions_user"
	ON "invitation_redemptions" ("user_id");

-- ---------------------------------------------------------------------------
-- 3. members.status — soft-delete marker for "leave team"
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "members"
	ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
