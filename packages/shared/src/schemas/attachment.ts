import { z } from "zod";

/**
 * Per-attachment hard byte cap enforced server-side.
 *
 * Sized for the foreseeable upload mix (mostly images, occasional small docs)
 * while keeping a single `attachments.data` bytea row comfortably inside
 * PostgreSQL TOAST's compressed-out-of-line sweet spot. Bumping requires both
 * a route-level `bodyLimit` raise and a re-examination of any downstream
 * consumer that streams the bytes back through Node's heap.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Header name (case-insensitive) carrying the original filename on upload.
 * Octet-stream uploads do not carry a filename in `Content-Disposition`, so
 * the SDK forwards the user-visible name in this header. Server falls back
 * to a generic name when the header is absent or empty.
 */
export const ATTACHMENT_FILENAME_HEADER = "x-attachment-filename";

/**
 * Header name (case-insensitive) carrying the original MIME type on upload.
 * The wire-level `Content-Type` is always `application/octet-stream` so the
 * server's body parser stays uniform; the *logical* mime (e.g. `image/png`)
 * rides in this header and is what we persist into `attachments.mime_type`.
 */
export const ATTACHMENT_MIME_HEADER = "x-attachment-mime";

/**
 * What the server returns on successful upload and what GET responses for
 * an `?meta=1` style probe would return. Today GET only streams bytes, but
 * the shape is the canonical metadata contract.
 */
export const attachmentMetadataSchema = z.object({
  id: z.string().uuid(),
  mimeType: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  uploadedBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

export const uploadAttachmentResponseSchema = attachmentMetadataSchema;
export type UploadAttachmentResponse = z.infer<typeof uploadAttachmentResponseSchema>;
