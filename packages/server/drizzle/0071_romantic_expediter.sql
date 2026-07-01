CREATE TABLE "github_app_install_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"installer_github_id" bigint NOT NULL,
	"target_organization_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD COLUMN "installer_github_id" bigint;--> statement-breakpoint
ALTER TABLE "github_app_install_intents" ADD CONSTRAINT "github_app_install_intents_target_organization_id_organizations_id_fk" FOREIGN KEY ("target_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_app_install_intents_installer" ON "github_app_install_intents" USING btree ("installer_github_id");--> statement-breakpoint
CREATE INDEX "idx_github_app_install_intents_expires" ON "github_app_install_intents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_github_app_installations_installer" ON "github_app_installations" USING btree ("installer_github_id");