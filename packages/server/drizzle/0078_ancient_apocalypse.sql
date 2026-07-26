DROP INDEX "uq_auth_identities_user_github";--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "uq_auth_identities_user_provider" UNIQUE("user_id","provider");