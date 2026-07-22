import { z } from "zod";

/**
 * Per-attachment hard byte cap enforced server-side.
 *
 * Sized for the foreseeable upload mix (mostly images, occasional small
 * docs). On the S3 streaming path the cap is enforced by the upload counting
 * stream (route `bodyLimit` does not fire for stream-pass-through parsers),
 * and on the legacy bytea path it keeps a row comfortably inside PostgreSQL
 * TOAST's compressed-out-of-line sweet spot.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Per-organization attachment storage quota, counted as the sum of
 * `attachments.size_bytes` over the org's rows. 2 GiB in the binary (GiB)
 * sense — 2 * 1024^3 bytes, NOT 2 GB (2 * 10^9). Enforced as a hard reject
 * (422) on the upload path; existing content over the line is not deleted.
 */
export const ORG_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Per-organization attachment count quota. Independent of the byte quota —
 * an org full of tiny files hits this first. Enforced as a hard reject (422).
 */
export const ORG_ATTACHMENT_MAX_COUNT = 1000;

/**
 * Grace period before an unreferenced attachment becomes an orphan-sweep
 * candidate. Generous on purpose: a freshly uploaded blob is referenced only
 * once the sender's message lands, and send retries / client outages can lag.
 * 24h makes a wrongful sweep-delete practically impossible.
 */
export const ATTACHMENT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * In-flight upload concurrency guardrails. Two levels, both per server
 * process (in a multi-replica deployment the effective ceiling scales with
 * the replica count — the guard bounds per-process heap, not the fleet):
 * `@aws-sdk/lib-storage` buffers roughly 20 MiB per streaming upload
 * (4 parts x 5 MiB), so the global cap keeps worst-case upload buffering at
 * ~640 MiB per process. Exceeding either cap rejects with 429.
 */
export const ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER = 10;
export const ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_GLOBAL = 32;

/**
 * Stable machine-readable error codes carried on the JSON error body
 * (`{ error, code, traceId }`) so SDK / web clients can branch without
 * message-sniffing.
 */

/** 422 — the organization is over its attachment byte or count quota. */
export const ATTACHMENT_QUOTA_EXCEEDED = "ATTACHMENT_QUOTA_EXCEEDED";
/** 429 — too many in-flight uploads for this uploader or this process. */
export const ATTACHMENT_UPLOAD_CONCURRENCY_EXCEEDED = "ATTACHMENT_UPLOAD_CONCURRENCY_EXCEEDED";
/** 503 — the deployment has no S3 block configured; upload/delete paths fail fast. */
export const ATTACHMENT_STORAGE_NOT_CONFIGURED = "ATTACHMENT_STORAGE_NOT_CONFIGURED";

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
