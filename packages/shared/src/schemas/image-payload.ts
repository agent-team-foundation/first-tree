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
 * Server → client WS frame carrying the full image bytes for an image
 * message. Pushed before the corresponding `new_message` notification so
 * the client has the file on disk by the time it polls the message.
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
