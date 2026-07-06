import type { DocAnchor } from "@first-tree/shared";
import { type AnyPgColumn, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Document review (docloop) table group.
 *
 * Self-contained by design: the feature must stay extractable into a
 * standalone product, so these tables reference the rest of the schema only
 * through the org FK and opaque author ids. Author columns
 * (`*_kind` / `*_id` / `*_name`) snapshot the writing identity — `id` is an
 * agents-table uuid (the acting agent, or a member's human identity-mirror
 * agent), deliberately WITHOUT a foreign key so rows outlive agent removal,
 * and `name` keeps rows renderable without a join.
 */
export const docDocuments = pgTable(
  "doc_documents",
  {
    /** UUID v7. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Org-unique, URL-safe key; the idempotent publish handle. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** Optional grouping label (free-form, e.g. a repo or initiative name). */
    project: text("project"),
    /** draft | in_review | approved | archived (docStatusSchema). */
    status: text("status").notNull().default("draft"),
    /** Highest doc_versions.number; ≥ 1 once published (publish creates v1). */
    latestVersion: integer("latest_version").notNull().default(0),
    createdByKind: text("created_by_kind").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Bumped on publish, status change, and comment activity; list-order key. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("doc_documents_org_slug_unique").on(table.organizationId, table.slug),
    index("doc_documents_org_updated_idx").on(table.organizationId, table.updatedAt),
  ],
);

export const docVersions = pgTable(
  "doc_versions",
  {
    /** UUID v7. */
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => docDocuments.id),
    /** 1-based, dense, append-only per document. */
    number: integer("number").notNull(),
    /** Markdown source, verbatim as published. */
    content: text("content").notNull(),
    /** Author's "what changed" note for this version. */
    note: text("note"),
    authorKind: text("author_kind").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("doc_versions_document_number_unique").on(table.documentId, table.number)],
);

export const docComments = pgTable(
  "doc_comments",
  {
    /** UUID v7. */
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => docDocuments.id),
    /** Version the comment targets; replies inherit the parent's. */
    versionNumber: integer("version_number").notNull(),
    /** Top-level comments: NULL. Replies: the top-level comment's id (one level deep). */
    parentId: text("parent_id").references((): AnyPgColumn => docComments.id),
    authorKind: text("author_kind").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    /** TextQuoteSelector anchor into the markdown source; NULL for document-level comments and replies. */
    anchor: jsonb("anchor").$type<DocAnchor>(),
    /** open | resolved (docCommentStatusSchema). Lives on the top-level comment; replies stay "open". */
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("doc_comments_document_status_idx").on(table.documentId, table.status),
    index("doc_comments_parent_idx").on(table.parentId),
  ],
);
