CREATE TABLE "consumed_token_ids" (
	"jti" text PRIMARY KEY NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_consumed_token_ids_expires_at" ON "consumed_token_ids" USING btree ("expires_at");