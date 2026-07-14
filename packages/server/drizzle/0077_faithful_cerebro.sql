CREATE TABLE "gitlab_connection_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"actor_member_id" text,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gitlab_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"instance_origin" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"recovery_pending" boolean DEFAULT false NOT NULL,
	"automatic_actions_enabled" boolean DEFAULT false NOT NULL,
	"automatic_actions_accepted_at" timestamp with time zone,
	"automatic_actions_accepted_by_member_id" text,
	"reviewer_mode" text DEFAULT 'unknown' NOT NULL,
	"last_valid_inbound_at" timestamp with time zone,
	"last_processing_failure_at" timestamp with time zone,
	"last_processing_failure_code" text,
	"created_by_member_id" text,
	"disabled_at" timestamp with time zone,
	"disabled_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_connections_reviewer_mode" CHECK ("gitlab_connections"."reviewer_mode" IN ('unknown', 'assignee', 'reviewers')),
	CONSTRAINT "ck_gitlab_connections_disabled_mode" CHECK ("gitlab_connections"."disabled_mode" IS NULL OR "gitlab_connections"."disabled_mode" IN ('normal', 'incident'))
);
--> statement-breakpoint
CREATE TABLE "gitlab_endpoint_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"generation" integer NOT NULL,
	"token_hash" text NOT NULL,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_endpoint_status" CHECK ("gitlab_endpoint_generations"."status" IN ('current', 'previous', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "gitlab_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_iid" integer NOT NULL,
	"project_id" bigint NOT NULL,
	"project_path" text NOT NULL,
	"project_path_normalized" text NOT NULL,
	"entity_url" text NOT NULL,
	"title" text,
	"entity_state" text DEFAULT 'open' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_entities_type" CHECK ("gitlab_entities"."entity_type" IN ('issue', 'pull_request'))
);
--> statement-breakpoint
CREATE TABLE "gitlab_entity_chat_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"declared_by_agent_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_iid" integer NOT NULL,
	"entity_id" text,
	"project_id" bigint,
	"project_path" text NOT NULL,
	"project_path_normalized" text NOT NULL,
	"entity_url" text NOT NULL,
	"title" text,
	"entity_state" text DEFAULT 'open' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_conflict_at" timestamp with time zone,
	"last_conflict_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_entity_type" CHECK ("gitlab_entity_chat_mappings"."entity_type" IN ('issue', 'pull_request')),
	CONSTRAINT "ck_gitlab_entity_status" CHECK ("gitlab_entity_chat_mappings"."status" IN ('pending', 'observed'))
);
--> statement-breakpoint
ALTER TABLE "gitlab_connection_audit_events" ADD CONSTRAINT "gitlab_connection_audit_events_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_automatic_actions_accepted_by_member_id_members_id_fk" FOREIGN KEY ("automatic_actions_accepted_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_endpoint_generations" ADD CONSTRAINT "gitlab_endpoint_generations_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entities" ADD CONSTRAINT "gitlab_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entities" ADD CONSTRAINT "gitlab_entities_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_declared_by_agent_id_agents_uuid_fk" FOREIGN KEY ("declared_by_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_entity_id_gitlab_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."gitlab_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gitlab_connection_audit_connection" ON "gitlab_connection_audit_events" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gitlab_connections_org" ON "gitlab_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_endpoint_token_hash" ON "gitlab_endpoint_generations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_endpoint_generation" ON "gitlab_endpoint_generations" USING btree ("connection_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_endpoint_current" ON "gitlab_endpoint_generations" USING btree ("connection_id") WHERE "gitlab_endpoint_generations"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_endpoint_previous" ON "gitlab_endpoint_generations" USING btree ("connection_id") WHERE "gitlab_endpoint_generations"."status" = 'previous';--> statement-breakpoint
CREATE INDEX "idx_gitlab_endpoint_connection" ON "gitlab_endpoint_generations" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_numeric_identity" ON "gitlab_entities" USING btree ("connection_id","project_id","entity_type","entity_iid");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_current_path" ON "gitlab_entities" USING btree ("connection_id","project_path_normalized","entity_type","entity_iid");--> statement-breakpoint
CREATE INDEX "idx_gitlab_entity_connection" ON "gitlab_entities" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_pending_chat" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","chat_id","project_path_normalized","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_observed_chat" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","chat_id","entity_id") WHERE "gitlab_entity_chat_mappings"."entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_gitlab_entity_observed_lookup" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","project_id","entity_type","entity_iid");--> statement-breakpoint
CREATE INDEX "idx_gitlab_entity_chat" ON "gitlab_entity_chat_mappings" USING btree ("chat_id");