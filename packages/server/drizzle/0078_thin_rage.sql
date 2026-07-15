CREATE TABLE "gitlab_automatic_actions_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"instance_origin" text NOT NULL,
	"enabled" boolean NOT NULL,
	"actor_member_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gitlab_identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"connection_id" text,
	"instance_origin" text NOT NULL,
	"display_username" text NOT NULL,
	"normalized_username" text NOT NULL,
	"state" text NOT NULL,
	"state_reason" text,
	"created_by_member_id" text,
	"confirmed_by_member_id" text,
	"confirmed_at" timestamp with time zone,
	"suspended_by_member_id" text,
	"suspended_at" timestamp with time zone,
	"revoked_by_member_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_identity_state" CHECK ("gitlab_identity_links"."state" IN ('active', 'suspended', 'revoked')),
	CONSTRAINT "ck_gitlab_identity_active_connection" CHECK ("gitlab_identity_links"."state" <> 'active' OR "gitlab_identity_links"."connection_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "gitlab_skipped_target_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"entity_key" text NOT NULL,
	"target_class" text NOT NULL,
	"external_username" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_skipped_target_class" CHECK ("gitlab_skipped_target_audit"."target_class" IN ('reviewer', 'assignee', 'mention')),
	CONSTRAINT "ck_gitlab_skipped_target_reason" CHECK ("gitlab_skipped_target_audit"."reason" IN ('automatic_actions_disabled', 'reviewer_mode_unconfirmed', 'review_target_schema_anomaly', 'identity_not_found', 'identity_not_active', 'membership_not_active', 'delegate_missing', 'delegate_ineligible'))
);
--> statement-breakpoint
DROP INDEX "uq_gitlab_entity_pending_chat";--> statement-breakpoint
DROP INDEX "uq_gitlab_entity_observed_chat";--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "stable_delivery_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "automatic_actions_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "automatic_actions_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "automatic_actions_accepted_by_member_id" text;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "reviewer_mode" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "assignee_mode_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "assignee_mode_confirmed_by_member_id" text;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "last_reviewer_schema_anomaly_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD COLUMN "last_reviewer_schema_anomaly_code" text;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD COLUMN "bound_via" text DEFAULT 'agent_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD COLUMN "identity_link_id" text;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD COLUMN "human_agent_id" text;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD COLUMN "delegate_agent_id" text;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "gitlab_automatic_actions_audit" ADD CONSTRAINT "gitlab_automatic_actions_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_automatic_actions_audit" ADD CONSTRAINT "gitlab_automatic_actions_audit_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_membership_id_members_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_confirmed_by_member_id_members_id_fk" FOREIGN KEY ("confirmed_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_suspended_by_member_id_members_id_fk" FOREIGN KEY ("suspended_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_links" ADD CONSTRAINT "gitlab_identity_links_revoked_by_member_id_members_id_fk" FOREIGN KEY ("revoked_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_skipped_target_audit" ADD CONSTRAINT "gitlab_skipped_target_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gitlab_automation_audit_org_created" ON "gitlab_automatic_actions_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_identity_active_membership" ON "gitlab_identity_links" USING btree ("connection_id","membership_id") WHERE "gitlab_identity_links"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_identity_active_username" ON "gitlab_identity_links" USING btree ("connection_id","normalized_username") WHERE "gitlab_identity_links"."state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_gitlab_identity_org_state" ON "gitlab_identity_links" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "idx_gitlab_identity_membership_state" ON "gitlab_identity_links" USING btree ("membership_id","state");--> statement-breakpoint
CREATE INDEX "idx_gitlab_skipped_target_org_created" ON "gitlab_skipped_target_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_automatic_actions_accepted_by_member_id_members_id_fk" FOREIGN KEY ("automatic_actions_accepted_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_assignee_mode_confirmed_by_member_id_members_id_fk" FOREIGN KEY ("assignee_mode_confirmed_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_identity_link_id_gitlab_identity_links_id_fk" FOREIGN KEY ("identity_link_id") REFERENCES "public"."gitlab_identity_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_human_agent_id_agents_uuid_fk" FOREIGN KEY ("human_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_delegate_agent_id_agents_uuid_fk" FOREIGN KEY ("delegate_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_identity_target" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","identity_link_id","project_id","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NOT NULL AND "gitlab_entity_chat_mappings"."active" AND "gitlab_entity_chat_mappings"."bound_via" = 'identity_target';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_pending_chat" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","chat_id","project_path_normalized","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NULL AND "gitlab_entity_chat_mappings"."active" AND "gitlab_entity_chat_mappings"."bound_via" <> 'identity_target';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_observed_chat" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","chat_id","project_id","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NOT NULL AND "gitlab_entity_chat_mappings"."active" AND "gitlab_entity_chat_mappings"."bound_via" <> 'identity_target';--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "ck_gitlab_connections_reviewer_mode" CHECK ("gitlab_connections"."reviewer_mode" IN ('unknown', 'assignee', 'reviewers'));--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "ck_gitlab_connections_automation_acceptance" CHECK (NOT "gitlab_connections"."automatic_actions_enabled" OR "gitlab_connections"."automatic_actions_accepted_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "ck_gitlab_entity_bound_via" CHECK ("gitlab_entity_chat_mappings"."bound_via" IN ('agent_declared', 'human_declared', 'identity_target'));--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "ck_gitlab_entity_identity_owner" CHECK ("gitlab_entity_chat_mappings"."bound_via" <> 'identity_target' OR ("gitlab_entity_chat_mappings"."identity_link_id" IS NOT NULL AND "gitlab_entity_chat_mappings"."human_agent_id" IS NOT NULL AND "gitlab_entity_chat_mappings"."delegate_agent_id" IS NOT NULL AND "gitlab_entity_chat_mappings"."project_id" IS NOT NULL));
