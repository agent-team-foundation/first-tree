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
 * Legacy inbound shape: an image message with base64 bytes inlined into
 * `messages.content`. Web still uploads in this shape so no new endpoint is
 * needed; the server extracts the bytes, broadcasts them as an `image_payload`
 * WS frame, then rewrites `content` to {@link imageRefContentSchema} before
 * the DB insert.
 */
export const imageInlineContentSchema = z.object({
  data: z.string().min(1),
  mimeType: supportedImageMimeSchema,
  filename: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  /** Optional caller-supplied id (UUID v4). Server generates one if absent. */
  imageId: z.string().uuid().optional(),
});
export type ImageInlineContent = z.infer<typeof imageInlineContentSchema>;

/**
 * What gets persisted to `messages.content` for image messages post-refactor.
 * The bytes live on each client's local disk (keyed by imageId) and in the
 * originating browser's IndexedDB — never in the DB.
 */
export const imageRefContentSchema = z.object({
  imageId: z.string().uuid(),
  mimeType: supportedImageMimeSchema,
  filename: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
});
export type ImageRefContent = z.infer<typeof imageRefContentSchema>;

/**
 * Batch inbound shape: a single `format: "file"` message that carries a text
 * caption plus 1+ image attachments. Server extracts each attachment's bytes,
 * pushes one `image_payload` WS frame per attachment, then rewrites `content`
 * to {@link imageBatchRefContentSchema} before the DB insert. Used so the
 * composer can send "caption + N images" as a single message (one bubble)
 * instead of producing N+1 separate rows.
 *
 * Backward compatibility: single-image messages keep using
 * {@link imageInlineContentSchema} — old clients are unaffected. Readers
 * choose the right shape via type guards (see `isImageBatchRefContent`).
 */
/**
 * Hard cap on attachments per batch. Fastify's route-level `bodyLimit`
 * (40 MB) is a byte limit, not a count — without an array `.max()` a single
 * authenticated POST could carry hundreds of small images and fan out to
 * every recipient. The original "send N images" UX needs ~5-10 images at
 * most, so 20 is generous-but-finite. Bump only with product sign-off, and
 * only after the broadcast / WS frame paths are stressed.
 */
export const MAX_BATCH_ATTACHMENTS = 20;

export const imageBatchInlineContentSchema = z.object({
  caption: z.string().optional(),
  attachments: z.array(imageInlineContentSchema).min(1).max(MAX_BATCH_ATTACHMENTS),
});
export type ImageBatchInlineContent = z.infer<typeof imageBatchInlineContentSchema>;

/**
 * Persisted batch shape (caption + N image refs). Mirrors
 * {@link imageBatchInlineContentSchema} after the server has stripped the
 * bytes into per-attachment WS pushes.
 */
export const imageBatchRefContentSchema = z.object({
  caption: z.string().optional(),
  attachments: z.array(imageRefContentSchema).min(1).max(MAX_BATCH_ATTACHMENTS),
});
export type ImageBatchRefContent = z.infer<typeof imageBatchRefContentSchema>;

/**
 * Server → client WS frame carrying the full image bytes for an image
 * message. Pushed before the corresponding `inbox:deliver` frame so the
 * client has the file on disk by the time it renders the message.
 *
 * Best-effort: if the target client WS lives on a different server
 * instance (or is offline), the frame is lost and the reference message
 * will surface a "not available on this device" placeholder downstream.
 */
export const imagePayloadFrameSchema = z.object({
  type: z.literal("image_payload"),
  imageId: z.string().uuid(),
  chatId: z.string(),
  base64: z.string().min(1),
  mimeType: supportedImageMimeSchema,
  filename: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
});
export type ImagePayloadFrame = z.infer<typeof imagePayloadFrameSchema>;

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
