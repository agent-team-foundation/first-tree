import type { FastifyInstance, FastifyReply } from "fastify";
import { NotFoundError, ServiceUnavailableError } from "../errors.js";
import { loadAttachmentData, loadAttachmentMeta } from "../services/attachment.js";
import { attachmentObjectKey, contentDisposition } from "../services/object-storage.js";

/**
 * Object-storage primitive — download surface.
 *
 *   GET /api/v1/attachments/:id   — download bytes
 *
 * Mounted under `userScope` (app.ts), so a valid user JWT is required.
 *
 * Download auth is a **capability model**: the only gates are (1) a valid
 * user JWT — enforced by the scope's `userAuth` hook — and (2) knowledge of
 * the unguessable UUIDv4 id. There is no per-attachment ACL: the id itself
 * is the bearer capability. A consumer that wants stronger, attachment-scoped
 * authorization layers it on top (e.g. an image message hands the id only to
 * its legitimate recipients); the primitive deliberately stays thin.
 *
 * Serving modes (config `attachments.downloadMode`):
 *
 * - `proxy` (default): the payload is piped from object storage through the
 *   server — no full-object buffering, works with any bucket topology.
 * - `redirect`: 302 to a short-lived presigned URL. Cheaper at scale but
 *   requires a browser-reachable bucket with CORS for the web origin.
 *
 * Rows the migration command has not moved yet still carry the payload in
 * the legacy `bytea` column and are served from PG directly (bounded by the
 * 10 MiB cap); a row migrated between the metadata read and the payload
 * read falls through to object storage via the deterministic key.
 *
 * Upload lives separately at `POST /api/v1/orgs/:orgId/attachments`
 * (Class B) because the uploader identity is org-scoped — see
 * api/orgs/attachments.ts.
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/:id", { config: { otelRecordBody: false } }, async (request, reply) => {
    const { id } = request.params;

    // Load metadata only — the ETag check runs off this, so a 304 cache hit
    // never touches the payload (in PG or object storage).
    const meta = await loadAttachmentMeta(app.db, id);
    if (!meta || meta.state !== "stored") {
      // `pending` uploads and `deleting` tombstones are not observable.
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    // If-None-Match: cheap ETag check. id is content-stable (UUIDv4 + bytes
    // are immutable once written), so we never need to vary on anything else.
    const ifNoneMatch = request.headers["if-none-match"];
    const etag = `"${meta.id}"`;
    if (ifNoneMatch === etag) {
      return reply.status(304).send();
    }

    // Transitional branch: payload still inline in PG (pre-migration row).
    if (!meta.objectKey) {
      const data = await loadAttachmentData(app.db, id);
      if (data) {
        setPayloadHeaders(reply, meta.mimeType, meta.filename, etag);
        reply.header("Content-Length", meta.sizeBytes);
        return reply.send(data);
      }
      // Migrated between the two reads — fall through to object storage on
      // the deterministic key.
    }

    const objectStorage = app.objectStorage;
    if (!objectStorage) {
      throw new ServiceUnavailableError(
        "Object storage is not configured (FIRST_TREE_S3_*); this attachment's payload has been migrated and cannot be served",
      );
    }
    const objectKey = meta.objectKey ?? attachmentObjectKey(meta.id);

    if (app.config.attachments.downloadMode === "redirect") {
      const url = await objectStorage.presignGetUrl(objectKey, {
        filename: meta.filename,
        mimeType: meta.mimeType,
        disposition: "inline",
      });
      // The presigned URL itself is the short-lived secret — never cache it.
      return reply.status(302).header("Cache-Control", "private, no-store").header("Location", url).send();
    }

    const object = await objectStorage.getObjectStream(objectKey);
    if (!object) {
      // A `stored` row without its object is corruption — be loud in logs,
      // honest (404) on the wire.
      request.log.error({ attachmentId: id, objectKey }, "stored attachment payload missing from object storage");
      throw new NotFoundError(`Attachment "${id}" not found`);
    }
    setPayloadHeaders(reply, meta.mimeType, meta.filename, etag);
    reply.header("Content-Length", meta.sizeBytes);
    // Fastify destroys a streamed body when the client goes away, but only
    // once it starts reading; cover the pre-read abort window too.
    reply.raw.once("close", () => {
      object.body.destroy();
    });
    return reply.send(object.body);
  });
}

function setPayloadHeaders(reply: FastifyReply, mimeType: string, filename: string, etag: string): void {
  reply
    .header("Content-Type", mimeType)
    .header("Cache-Control", "private, max-age=31536000, immutable")
    .header("ETag", etag)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Disposition", contentDisposition(filename, "inline"));
}
