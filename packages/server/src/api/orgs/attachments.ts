import { Readable } from "node:stream";
import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  MAX_ATTACHMENT_BYTES,
  type UploadAttachmentResponse,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { createAttachmentFromStream } from "../../services/attachment.js";

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
 * dependency.
 *
 * The scoped parser below passes the body through as a STREAM (it replaces
 * the old global buffering parser, which loaded every upload fully into the
 * Node heap). Bytes flow straight to S3 behind a counting stream in the
 * service — the single-file cap is enforced there (413), NOT by the route
 * `bodyLimit`: Fastify enforces `bodyLimit` only for buffering parsers
 * (`parseAs: "buffer"`), so with a pass-through stream the counting stream
 * is the one real size gate. `bodyLimit` stays as documentation of intent.
 *
 * Download lives separately at `GET /api/v1/attachments/:id` — see
 * api/attachments.ts.
 */
export async function orgAttachmentRoutes(app: FastifyInstance): Promise<void> {
  // Scoped content-type parser: hands the raw request stream to the route
  // as `request.body` without buffering it. Registering it inside this
  // plugin scope (Fastify encapsulation) overrides any inherited parser for
  // these routes only — precedent: the GitHub App webhook's scoped raw-body
  // JSON parser (api/webhooks/github-app.ts).
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

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
      if (!(body instanceof Readable)) {
        throw new BadRequestError("Request body must be raw bytes");
      }

      const mimeHeader = request.headers[ATTACHMENT_MIME_HEADER];
      const mimeType = (Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader)?.trim() ?? "";
      if (!mimeType) {
        throw new BadRequestError(`Missing ${ATTACHMENT_MIME_HEADER} header`);
      }

      const filenameHeader = request.headers[ATTACHMENT_FILENAME_HEADER];
      const filename = (Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader)?.trim() || "blob";

      const row = await createAttachmentFromStream(app.db, app.attachmentStore, {
        mimeType,
        filename,
        stream: body,
        uploadedBy: scope.humanAgentId,
        orgId: scope.organizationId,
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
