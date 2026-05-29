import { z } from "zod";

/**
 * MIME types the web + client image paths recognise. Kept in sync with
 * Claude's vision API (see packages/client/src/handlers/claude-code.ts).
 */
export const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const supportedImageMimeSchema = z.enum(SUPPORTED_IMAGE_MIMES);
export type SupportedImageMime = z.infer<typeof supportedImageMimeSchema>;

export const IMAGE_MIME_TO_EXT: Record<SupportedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * What gets persisted to `messages.content` for a single-image message. The
 * `imageId` is the id of an `attachments` row: the sender uploads the bytes to
 * `POST /orgs/:orgId/attachments` first, then sends a message carrying only
 * this reference. Every client fetches the bytes on demand from
 * `GET /attachments/:imageId` — bytes never travel in `messages.content`.
 */
export const imageRefContentSchema = z.object({
  imageId: z.string().uuid(),
  mimeType: supportedImageMimeSchema,
  filename: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
});
export type ImageRefContent = z.infer<typeof imageRefContentSchema>;

/**
 * Hard cap on attachments per batch — a single `format: "file"` message that
 * carries a text caption plus 1+ image references. The composer sends "caption
 * + N images" as one message (one bubble) instead of N+1 rows. The cap keeps
 * the ref array (and the per-attachment fetches it implies on render) finite;
 * the original "send N images" UX needs ~5-10 images at most, so 20 is
 * generous-but-finite. Bump only with product sign-off.
 */
export const MAX_BATCH_ATTACHMENTS = 20;

/**
 * Persisted batch shape: a caption plus N image refs. Each ref points at an
 * `attachments` row the sender uploaded before sending the message.
 */
export const imageBatchRefContentSchema = z.object({
  caption: z.string().optional(),
  attachments: z.array(imageRefContentSchema).min(1).max(MAX_BATCH_ATTACHMENTS),
});
export type ImageBatchRefContent = z.infer<typeof imageBatchRefContentSchema>;

/**
 * Type guards for the persisted `messages.content` shapes. Hand-rolled
 * (instead of `schema.safeParse`) so they stay cheap in hot paths —
 * every inbound message in chat-view / agent-io / adapter-manager passes
 * through these on render. The shape contract here mirrors the schemas
 * above; if either schema gains a required field the guard must match.
 *
 * These live in shared so consumers (claude-code handler, agent-io
 * renderer, web chat-view, server message service) can't drift from each
 * other on what counts as a valid ref / batch.
 */
const SUPPORTED_MIMES_SET = new Set<string>(SUPPORTED_IMAGE_MIMES);

export function isImageRefContent(content: unknown): content is ImageRefContent {
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  return (
    typeof c.imageId === "string" &&
    typeof c.mimeType === "string" &&
    SUPPORTED_MIMES_SET.has(c.mimeType) &&
    typeof c.filename === "string"
  );
}

export function isImageBatchRefContent(content: unknown): content is ImageBatchRefContent {
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  if (!Array.isArray(c.attachments) || c.attachments.length === 0) return false;
  return c.attachments.every((a) => isImageRefContent(a));
}

/**
 * Extract the user-typed caption from a batched-image message's content.
 * Returns "" when the content has no string caption (single-image messages
 * or any non-batch shape), so callers can use the result unconditionally
 * for mention-extraction / preview-text fallback.
 */
export function extractCaption(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const caption = (content as { caption?: unknown }).caption;
  return typeof caption === "string" ? caption : "";
}
