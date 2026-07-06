CREATE TABLE "doc_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"parent_id" text,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"anchor" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"project" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"latest_version" integer DEFAULT 0 NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"number" integer NOT NULL,
	"content" text NOT NULL,
	"note" text,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_document_id_doc_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."doc_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_parent_id_doc_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."doc_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_documents" ADD CONSTRAINT "doc_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_document_id_doc_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."doc_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_comments_document_status_idx" ON "doc_comments" USING btree ("document_id","status");--> statement-breakpoint
CREATE INDEX "doc_comments_parent_idx" ON "doc_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_documents_org_slug_unique" ON "doc_documents" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "doc_documents_org_updated_idx" ON "doc_documents" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_versions_document_number_unique" ON "doc_versions" USING btree ("document_id","number");