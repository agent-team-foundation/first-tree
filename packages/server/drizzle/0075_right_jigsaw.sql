ALTER TABLE "github_app_install_intents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "github_app_install_intents" CASCADE;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD COLUMN "requester_github_id" bigint;--> statement-breakpoint
CREATE INDEX "idx_github_app_installations_requester" ON "github_app_installations" USING btree ("requester_github_id");