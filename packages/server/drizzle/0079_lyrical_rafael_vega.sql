CREATE TABLE "gitlab_identity_transition_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"identity_link_id" text NOT NULL,
	"connection_id" text,
	"instance_origin" text NOT NULL,
	"membership_id" text NOT NULL,
	"display_username" text NOT NULL,
	"normalized_username" text NOT NULL,
	"transition" text NOT NULL,
	"actor_member_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_gitlab_identity_transition" CHECK ("gitlab_identity_transition_audit"."transition" IN ('created', 'suspended', 'reconfirmed', 'revoked', 'member_left', 'member_removed', 'connection_removed'))
);
--> statement-breakpoint
ALTER TABLE "gitlab_identity_transition_audit" ADD CONSTRAINT "gitlab_identity_transition_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_transition_audit" ADD CONSTRAINT "gitlab_identity_transition_audit_identity_link_id_gitlab_identity_links_id_fk" FOREIGN KEY ("identity_link_id") REFERENCES "public"."gitlab_identity_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_identity_transition_audit" ADD CONSTRAINT "gitlab_identity_transition_audit_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gitlab_identity_transition_org_created" ON "gitlab_identity_transition_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gitlab_identity_transition_link_created" ON "gitlab_identity_transition_audit" USING btree ("identity_link_id","created_at");