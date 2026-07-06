CREATE TABLE "github_app_install_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"initiator_github_id" bigint NOT NULL,
	"target_organization_id" text NOT NULL,
	"kickoff_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_app_install_requests" ADD CONSTRAINT "github_app_install_requests_target_organization_id_organizations_id_fk" FOREIGN KEY ("target_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_app_install_requests_initiator_org" ON "github_app_install_requests" USING btree ("initiator_github_id","target_organization_id");--> statement-breakpoint
CREATE INDEX "idx_github_app_install_requests_initiator" ON "github_app_install_requests" USING btree ("initiator_github_id");--> statement-breakpoint
CREATE INDEX "idx_github_app_install_requests_expires" ON "github_app_install_requests" USING btree ("expires_at");