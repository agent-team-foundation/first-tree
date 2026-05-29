import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  MAX_ATTACHMENT_BYTES,
  type UploadAttachmentResponse,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { createAttachment } from "../../services/attachment.js";

/**
 * Object-storage primitive — upload surface (Class B, org-scoped).
 *
 *   POST /api/v1/orgs/:orgId/attachments   — upload bytes
 *
 * Org-scoped because `uploaded_by` must resolve to a stable team identity:
 * `requireOrgMembership` reads the caller's active member in `:orgId` and
 * yields their `humanAgentId` deterministically. Putting the org in the path
 * (rather than a `?orgId=` query) follows the repo's HTTP path convention and
 * removes the multi-org ambiguity a query param would leave open.
 *
 * Upload protocol: `Content-Type: application/octet-stream` body + the
 * `x-attachment-mime` / `x-attachment-filename` headers carry the logical
 * metadata. This keeps the body parser uniform and avoids a multipart
 * dependency. The byte cap is enforced both as a route `bodyLimit` and again
 * in the service layer.
 *
 * Download lives separately at `GET /api/v1/attachments/:id` — see
 * api/attachments.ts.
 */
export async function orgAttachmentRoutes(app: FastifyInstance): Promise<void> {
  // Single value for both client visibility (415 if wrong type) and route
  // bodyLimit. 16 KB headroom beyond MAX_ATTACHMENT_BYTES leaves space for
  // misc small request overhead without inflating the cap.
  const UPLOAD_BODY_LIMIT = MAX_ATTACHMENT_BYTES + 16 * 1024;

  app.post<{ Params: { orgId: string } }>(
    "/",
    {
      bodyLimit: UPLOAD_BODY_LIMIT,
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

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new BadRequestError("Request body must be raw bytes");
      }

      const mimeHeader = request.headers[ATTACHMENT_MIME_HEADER];
      const mimeType = (Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader)?.trim() ?? "";
      if (!mimeType) {
        throw new BadRequestError(`Missing ${ATTACHMENT_MIME_HEADER} header`);
      }

      const filenameHeader = request.headers[ATTACHMENT_FILENAME_HEADER];
      const filename = (Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader)?.trim() || "blob";

      const row = await createAttachment(app.db, {
        mimeType,
        filename,
        data: body,
        uploadedBy: scope.humanAgentId,
      });

      const response: UploadAttachmentResponse = {
        id: row.id,
        mimeType: row.mimeType,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        uploadedBy: row.uploadedBy,
        createdAt: row.createdAt.toISOString(),
      };
      return reply.status(201).send(response);
    },
  );
}
