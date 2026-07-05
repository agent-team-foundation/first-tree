import { z } from "zod";
import { agentTypeSchema } from "./agent.js";

// ── Document review (docloop) ───────────────────────────────────────────────
//
// Shared DTOs for the org document library: agents publish markdown design
// docs and pull structured review comments; humans read and annotate in the
// web UI. Documents are org-scoped, addressed by an org-unique `slug`, and
// versioned append-only (every publish of an existing slug creates the next
// version). Comments anchor to a text range via a W3C TextQuoteSelector-style
// `{ exact, prefix, suffix }` so they survive re-rendering and can be
// re-anchored across versions.

export const DOC_STATUSES = {
  DRAFT: "draft",
  IN_REVIEW: "in_review",
  APPROVED: "approved",
  ARCHIVED: "archived",
} as const;

export const docStatusSchema = z.enum(["draft", "in_review", "approved", "archived"]);
export type DocStatus = z.infer<typeof docStatusSchema>;

export const DOC_COMMENT_STATUSES = {
  OPEN: "open",
  RESOLVED: "resolved",
} as const;

export const docCommentStatusSchema = z.enum(["open", "resolved"]);
export type DocCommentStatus = z.infer<typeof docCommentStatusSchema>;

/**
 * Author of a document version or comment. `id` is always an agents-table
 * uuid: the acting agent for kind="agent", the member's human identity-mirror
 * agent for kind="human". `name` is a display-name snapshot taken at write
 * time so rows stay renderable even if the agent is later renamed or removed.
 */
export const docAuthorSchema = z.object({
  kind: agentTypeSchema,
  id: z.string(),
  name: z.string(),
});
export type DocAuthor = z.infer<typeof docAuthorSchema>;

export const DOC_ANCHOR_EXACT_MAX = 2_000;
export const DOC_ANCHOR_CONTEXT_MAX = 500;

/**
 * Text-range anchor (W3C TextQuoteSelector style). `exact` is the quoted
 * target text; `prefix` / `suffix` disambiguate when the quote appears more
 * than once. Anchors are matched against the markdown source, not the
 * rendered HTML, so agents can locate them in the file they hold.
 */
export const docAnchorSchema = z.object({
  exact: z.string().min(1).max(DOC_ANCHOR_EXACT_MAX),
  prefix: z.string().max(DOC_ANCHOR_CONTEXT_MAX).optional(),
  suffix: z.string().max(DOC_ANCHOR_CONTEXT_MAX).optional(),
});
export type DocAnchor = z.infer<typeof docAnchorSchema>;

export const DOC_SLUG_MAX = 200;

/**
 * Org-unique, URL-safe document key; the idempotent publish handle. No dots:
 * a slug rides in the share URL path (`/context/docs/<slug>`), and the
 * server's SPA fallback treats any path with an extension-like suffix as a
 * static asset — a dotted slug would 404 on direct load / refresh.
 */
export const docSlugSchema = z
  .string()
  .min(1)
  .max(DOC_SLUG_MAX)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "slug must be lowercase alphanumerics separated by single '-' or '_'");

export const DOC_TITLE_MAX = 500;
export const DOC_PROJECT_MAX = 200;
export const DOC_VERSION_NOTE_MAX = 2_000;
export const DOC_COMMENT_BODY_MAX = 20_000;
/**
 * Markdown source cap per version, in UTF-16 code units (what
 * `z.string().max` counts) — NOT bytes: all-CJK content can reach ~3× this
 * in UTF-8. Generous for design docs, bounded for abuse.
 */
export const DOC_CONTENT_MAX_CHARS = 2_000_000;

/**
 * Route-level body limit for the publish endpoints. Fastify's default JSON
 * body limit (~1 MiB) would reject documents the schema cap allows. The 4×
 * factor covers UTF-8 and JSON-escape inflation of a max-char `content`
 * (BMP CJK encodes to 3 bytes per UTF-16 unit, astral pairs to 2 bytes per
 * unit, common escapes to 2); the tail is headroom for the other fields.
 * The real content cap is enforced by `publishDocRequestSchema`.
 */
export const DOC_PUBLISH_BODY_LIMIT = DOC_CONTENT_MAX_CHARS * 4 + 64 * 1024;

export const publishDocRequestSchema = z.object({
  slug: docSlugSchema,
  /** Required on first publish; optional afterwards (existing title kept). */
  title: z.string().trim().min(1).max(DOC_TITLE_MAX).optional(),
  /** Optional grouping label; null clears it, undefined keeps the current value. */
  project: z.string().trim().min(1).max(DOC_PROJECT_MAX).nullish(),
  content: z.string().max(DOC_CONTENT_MAX_CHARS),
  /** What changed in this version — shown in the version history. */
  note: z.string().trim().max(DOC_VERSION_NOTE_MAX).optional(),
  status: docStatusSchema.optional(),
  /** When true, skip creating a new version if content equals the latest one. */
  ifChanged: z.boolean().optional().default(false),
});
export type PublishDocRequest = z.infer<typeof publishDocRequestSchema>;

export const publishDocResponseSchema = z.object({
  id: z.string(),
  slug: docSlugSchema,
  title: z.string(),
  project: z.string().nullable(),
  status: docStatusSchema,
  version: z.number().int(),
  /** True when this publish created the document (first version). */
  createdDocument: z.boolean(),
  /** False when `ifChanged` skipped an identical-content version. */
  createdVersion: z.boolean(),
});
export type PublishDocResponse = z.infer<typeof publishDocResponseSchema>;

export const docSummarySchema = z.object({
  id: z.string(),
  slug: docSlugSchema,
  title: z.string(),
  project: z.string().nullable(),
  status: docStatusSchema,
  latestVersion: z.number().int(),
  openCommentCount: z.number().int(),
  createdBy: docAuthorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocSummary = z.infer<typeof docSummarySchema>;

export const docVersionSchema = z.object({
  number: z.number().int(),
  content: z.string(),
  note: z.string().nullable(),
  author: docAuthorSchema,
  createdAt: z.string(),
});
export type DocVersion = z.infer<typeof docVersionSchema>;

/** Full read shape: summary plus one resolved version (latest by default). */
export const docWithVersionSchema = docSummarySchema.extend({
  version: docVersionSchema,
});
export type DocWithVersion = z.infer<typeof docWithVersionSchema>;

export const listDocsQuerySchema = z.object({
  /** Exact-match filters. `slug` is the CLI's slug→id resolution path. */
  slug: docSlugSchema.optional(),
  project: z.string().optional(),
  status: docStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  /** Opaque cursor — the `updatedAt` ISO timestamp of the previous page's last item. */
  cursor: z.string().optional(),
});
export type ListDocsQuery = z.infer<typeof listDocsQuerySchema>;

export const listDocsResponseSchema = z.object({
  items: z.array(docSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListDocsResponse = z.infer<typeof listDocsResponseSchema>;

export const updateDocRequestSchema = z.object({
  status: docStatusSchema,
});
export type UpdateDocRequest = z.infer<typeof updateDocRequestSchema>;

export const docCommentSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  /** Version the comment was made against (replies inherit the parent's). */
  versionNumber: z.number().int(),
  parentId: z.string().nullable(),
  author: docAuthorSchema,
  body: z.string(),
  anchor: docAnchorSchema.nullable(),
  status: docCommentStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocComment = z.infer<typeof docCommentSchema>;

export const createDocCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(DOC_COMMENT_BODY_MAX),
  /** Anchored comments target a text range; omit for a document-level comment. */
  anchor: docAnchorSchema.optional(),
  /** Defaults to the document's latest version. */
  versionNumber: z.coerce.number().int().positive().optional(),
  /** Threading: reply to an existing top-level comment. Replies carry no anchor. */
  parentId: z.string().optional(),
});
export type CreateDocCommentRequest = z.infer<typeof createDocCommentRequestSchema>;

export const replyDocCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(DOC_COMMENT_BODY_MAX),
});
export type ReplyDocCommentRequest = z.infer<typeof replyDocCommentRequestSchema>;

export const updateDocCommentRequestSchema = z.object({
  status: docCommentStatusSchema,
});
export type UpdateDocCommentRequest = z.infer<typeof updateDocCommentRequestSchema>;

export const listDocCommentsQuerySchema = z.object({
  status: docCommentStatusSchema.optional(),
  versionNumber: z.coerce.number().int().positive().optional(),
});
export type ListDocCommentsQuery = z.infer<typeof listDocCommentsQuerySchema>;

export const listDocCommentsResponseSchema = z.object({
  items: z.array(docCommentSchema),
});
export type ListDocCommentsResponse = z.infer<typeof listDocCommentsResponseSchema>;
