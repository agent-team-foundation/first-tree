ALTER TABLE "gitlab_automatic_actions_audit" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gitlab_identity_transition_audit" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gitlab_skipped_target_audit" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "gitlab_automatic_actions_audit" CASCADE;--> statement-breakpoint
DROP TABLE "gitlab_identity_transition_audit" CASCADE;--> statement-breakpoint
DROP TABLE "gitlab_skipped_target_audit" CASCADE;--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP CONSTRAINT "ck_gitlab_connections_automation_acceptance";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "ck_gitlab_identity_active_connection";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "ck_gitlab_identity_state";--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP CONSTRAINT "gitlab_connections_automatic_actions_accepted_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP CONSTRAINT "gitlab_connections_assignee_mode_confirmed_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "gitlab_identity_links_created_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "gitlab_identity_links_confirmed_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "gitlab_identity_links_suspended_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "gitlab_identity_links_revoked_by_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP CONSTRAINT "gitlab_identity_links_connection_id_gitlab_connections_id_fk";
--> statement-breakpoint
DROP INDEX "uq_gitlab_identity_active_membership";--> statement-breakpoint
DROP INDEX "uq_gitlab_identity_active_username";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "last_observed_version" text;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_identity_connection_membership" ON "gitlab_identity_links" USING btree ("connection_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_identity_connection_username" ON "gitlab_identity_links" USING btree ("connection_id","normalized_username");--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP COLUMN "automatic_actions_enabled";--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP COLUMN "automatic_actions_accepted_at";--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP COLUMN "automatic_actions_accepted_by_member_id";--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP COLUMN "assignee_mode_confirmed_at";--> statement-breakpoint
ALTER TABLE "gitlab_connections" DROP COLUMN "assignee_mode_confirmed_by_member_id";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "instance_origin";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "state_reason";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "created_by_member_id";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "confirmed_by_member_id";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "confirmed_at";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "suspended_by_member_id";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "suspended_at";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "revoked_by_member_id";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" DROP COLUMN "revoked_at";--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "ck_gitlab_identity_state" CHECK ("gitlab_identity_links"."state" IN ('active', 'suspended'));