import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ATTACHMENT_ERROR_CODES,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  MAX_ATTACHMENT_BYTES,
  type UploadAttachmentResponse,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import {
  BadRequestError,
  ConflictError,
  LengthRequiredError,
  PayloadTooLargeError,
  ServiceUnavailableError,
} from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { deletePendingReservation, finalizeAttachment, reserveAttachment } from "../../services/attachment.js";
import { createByteLimitStream, settleStreamingUpload } from "../../services/stream-limit.js";
import { createUploadGate } from "../../services/upload-gate.js";

/**
 * Object-storage primitive — upload surface (Class B, org-scoped).
 *
 *   POST /api/v1/orgs/:orgId/attachments   — upload bytes
 *
 * Org-scoped because `uploaded_by` must resolve to a stable team identity
 * and quota accounting needs an owning org: `requireOrgMembership` reads
 * the caller's active member in `:orgId` and yields their `humanAgentId`
 * deterministically.
 *
 * Upload protocol: `Content-Type: application/octet-stream` body + the
 * `x-attachment-mime` / `x-attachment-filename` headers carry the logical
 * metadata. `Content-Length` is REQUIRED (411 otherwise): the org quota is
 * reserved from the declared size before the body is consumed, and the
 * byte-limit stream enforces the declaration exactly.
 *
 * The body is never materialized in memory: a scoped content-type parser
 * hands the raw request stream through, and it is piped straight into the
 * object-storage PUT. Flow per request:
 *
 *   1. membership + header validation (before touching the body)
 *   2. per-uploader concurrency gate       → 429 ATTACHMENT_CONCURRENCY_EXCEEDED
 *   3. quota reservation (pending row)     → 413 / 422 ATTACHMENT_QUOTA_EXCEEDED
 *   4. stream to object storage (byte-limited)
 *   5. finalize: pending → stored CAS; a reservation reclaimed by the
 *      pending-TTL sweep mid-upload surfaces as 409
 *
 * Any failure after (3) best-effort deletes both the object and the
 * pending row; a crash instead leaves the reservation to the sweep.
 *
 * Download lives separately at `GET /api/v1/attachments/:id` — see
 * api/attachments.ts.
 */
export async function orgAttachmentRoutes(app: FastifyInstance): Promise<void> {
  // Plugin-scoped override of the global buffering octet-stream parser
  // (app.ts): this surface wants the raw request stream — buffering would
  // defeat the whole streaming path. Fastify clones parent parsers into the
  // encapsulated context, so the inherited one must be removed before the
  // passthrough can register; the override ends at this plugin's boundary.
  app.removeContentTypeParser("application/octet-stream");
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  const uploadGate = createUploadGate(app.config.attachments.maxConcurrentUploadsPerUploader);

  app.post<{ Params: { orgId: string } }>(
    "/",
    {
      config: { otelRecordBody: false },
    },
    async (request, reply) => {
      const scope = await requireOrgMembership(request, app.db);

      const contentType = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/octet-stream") {
        // Reject explicitly so callers can't smuggle a parsed body shape
        // and rely on the JSON parser eating the bytes.
        throw new BadRequestError(`Content-Type must be application/octet-stream (got "${contentType || "missing"}")`);
      }

      const objectStorage = app.objectStorage;
      if (!objectStorage) {
        throw new ServiceUnavailableError(
          "Object storage is not configured (FIRST_TREE_S3_*); attachment uploads are unavailable",
        );
      }

      const rawLength = request.headers["content-length"];
      const contentLength = typeof rawLength === "string" ? Number.parseInt(rawLength, 10) : Number.NaN;
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        // Quota is reserved from the declared size, so chunked transfer
        // encoding cannot be admitted.
        throw new LengthRequiredError("Attachment uploads must declare Content-Length");
      }
      if (contentLength === 0) {
        throw new BadRequestError("Attachment is empty");
      }
      if (contentLength > MAX_ATTACHMENT_BYTES) {
        throw new PayloadTooLargeError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`, {
          code: ATTACHMENT_ERROR_CODES.tooLarge,
        });
      }

      const mimeHeader = request.headers[ATTACHMENT_MIME_HEADER];
      const mimeType = (Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader)?.trim() ?? "";
      if (!mimeType) {
        throw new BadRequestError(`Missing ${ATTACHMENT_MIME_HEADER} header`);
      }

      const filenameHeader = request.headers[ATTACHMENT_FILENAME_HEADER];
      const filename = (Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader)?.trim() || "blob";

      const body = request.body;
      if (!(body instanceof Readable)) {
        throw new BadRequestError("Request body must be raw bytes");
      }

      const releaseSlot = uploadGate.acquire(scope.humanAgentId);
      try {
        const reserved = await reserveAttachment(app.db, {
          organizationId: scope.organizationId,
          mimeType,
          filename,
          sizeBytes: contentLength,
          uploadedBy: scope.humanAgentId,
          quota: {
            maxTotalBytes: app.config.attachments.orgQuotaBytes,
            maxObjectCount: app.config.attachments.orgQuotaCount,
          },
        });
        const objectKey = reserved.objectKey;
        if (!objectKey) {
          throw new Error("Attachment reservation is missing its object key");
        }

        try {
          const limiter = createByteLimitStream({
            expectedBytes: contentLength,
            makeMismatchError: (seenBytes) =>
              new BadRequestError(
                `Request body does not match Content-Length (declared ${contentLength}, saw ${seenBytes}${seenBytes > contentLength ? "+" : ""} bytes)`,
              ),
          });
          // The SDK consumes the limiter as the PUT body while pipeline()
          // pumps the request stream through it; settleStreamingUpload
          // cross-cancels the halves on failure and never orphans either
          // rejection.
          await settleStreamingUpload({
            limiter,
            producer: pipeline(body, limiter),
            startConsumer: (abortSignal) =>
              objectStorage.putObjectStream(objectKey, limiter, {
                contentLength,
                contentType: mimeType,
                abortSignal,
              }),
          });
        } catch (error) {
          // Best-effort rollback; a crash instead leaves the pending row to
          // the TTL sweep, which deletes object + row idempotently.
          await objectStorage.deleteObject(objectKey).catch(() => {});
          await deletePendingReservation(app.db, reserved.id).catch(() => {});
          throw error;
        }

        const finalized = await finalizeAttachment(app.db, reserved.id);
        if (!finalized) {
          // The upload outlived the pending TTL and the sweep reclaimed the
          // reservation. The object was just written — remove it again.
          await objectStorage.deleteObject(objectKey).catch(() => {});
          throw new ConflictError("Attachment upload exceeded the reservation window; retry the upload");
        }

        const response: UploadAttachmentResponse = {
          id: reserved.id,
          mimeType: reserved.mimeType,
          filename: reserved.filename,
          sizeBytes: reserved.sizeBytes,
          uploadedBy: reserved.uploadedBy,
          createdAt: reserved.createdAt.toISOString(),
        };
        return reply.status(201).send(response);
      } finally {
        releaseSlot();
      }
    },
  );
}
