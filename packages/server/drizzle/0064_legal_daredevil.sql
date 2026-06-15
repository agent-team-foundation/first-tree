ALTER TABLE "chats" ADD COLUMN "onboarding_kickoff_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chats_onboarding_kickoff_key" ON "chats" USING btree ("onboarding_kickoff_key");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "onboarding_dismissed_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "onboarding_completed_at";--> statement-breakpoint
--> Data backfill (hand-added: drizzle-kit cannot generate data migrations).
--> Reconcile any legacy "completed but not suppressed" rows BEFORE adding the
--> constraint below, so the new invariant can't fail closed on existing data.
UPDATE "members" SET "onboarding_suppressed_at" = "onboarding_completed_at", "onboarding_suppressed_reason" = 'completed' WHERE "onboarding_completed_at" IS NOT NULL AND "onboarding_suppressed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "ck_members_completed_implies_suppressed" CHECK ("members"."onboarding_completed_at" IS NULL OR "members"."onboarding_suppressed_at" IS NOT NULL);