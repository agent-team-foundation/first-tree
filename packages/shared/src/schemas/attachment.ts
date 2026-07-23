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
 * Default per-organization attachment quotas, enforced server-side as hard
 * rejects (422 with `ATTACHMENT_QUOTA_EXCEEDED`) at upload time. The byte
 * quota implements the governed "2 GB" limit as 2 GiB (2^31) to stay
 * consistent with the binary units used by `MAX_ATTACHMENT_BYTES`. Both are
 * deploy-time tunable via env; these constants are the defaults, and the
 * reject-on-exceed semantics do not vary with the configured value.
 */
export const ORG_ATTACHMENT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const ORG_ATTACHMENT_QUOTA_COUNT = 1000;

/**
 * Stable machine-readable error codes surfaced in the error response body
 * (`{ error, code }`) for attachment governance rejections. Clients must
 * match on `code`, not on the human-readable message.
 */
export const ATTACHMENT_ERROR_CODES = {
  /** Single file exceeds `MAX_ATTACHMENT_BYTES` (HTTP 413). */
  tooLarge: "ATTACHMENT_TOO_LARGE",
  /** Org byte or object-count quota exceeded (HTTP 422). */
  quotaExceeded: "ATTACHMENT_QUOTA_EXCEEDED",
  /** Uploader holds too many parallel upload streams (HTTP 429). */
  concurrencyExceeded: "ATTACHMENT_CONCURRENCY_EXCEEDED",
  /** Upload did not declare Content-Length (HTTP 411). */
  lengthRequired: "ATTACHMENT_LENGTH_REQUIRED",
} as const;

/**
 * Lifetime of presigned download URLs handed out in redirect mode. Fixed by
 * the governance spec ("short-lived, at most 5 minutes"), deliberately not
 * env-tunable.
 */
export const ATTACHMENT_PRESIGN_TTL_SECONDS = 300;

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
