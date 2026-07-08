CREATE TABLE "connect_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "connect_codes" ADD CONSTRAINT "connect_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connect_codes_user" ON "connect_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_connect_codes_expires_at" ON "connect_codes" USING btree ("expires_at");