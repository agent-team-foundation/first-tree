CREATE TABLE "gitlab_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"instance_origin" text NOT NULL,
	"token_hash" text NOT NULL,
	"endpoint_first_seen_at" timestamp with time zone,
	"last_valid_inbound_at" timestamp with time zone,
	"last_processing_failure_at" timestamp with time zone,
	"last_processing_failure_code" text,
	"created_by_member_id" text,
	"updated_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"project_id" bigint,
	"project_path" text NOT NULL,
	"project_path_normalized" text NOT NULL,
	"entity_url" text NOT NULL,
	"title" text,
	"entity_state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_entity_type" CHECK ("gitlab_entity_chat_mappings"."entity_type" IN ('issue', 'pull_request'))
);
--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_updated_by_member_id_members_id_fk" FOREIGN KEY ("updated_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_connection_id_gitlab_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gitlab_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_entity_chat_mappings" ADD CONSTRAINT "gitlab_entity_chat_mappings_declared_by_agent_id_agents_uuid_fk" FOREIGN KEY ("declared_by_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_connections_org" ON "gitlab_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_connections_token_hash" ON "gitlab_connections" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_pending_chat" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","chat_id","project_path_normalized","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gitlab_entity_observed_chat" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","chat_id","project_id","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_gitlab_entity_observed_lookup" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","project_id","entity_type","entity_iid");--> statement-breakpoint
CREATE INDEX "idx_gitlab_entity_pending_lookup" ON "gitlab_entity_chat_mappings" USING btree ("connection_id","project_path_normalized","entity_type","entity_iid") WHERE "gitlab_entity_chat_mappings"."project_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_gitlab_entity_chat" ON "gitlab_entity_chat_mappings" USING btree ("chat_id");