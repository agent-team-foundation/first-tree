import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../errors.js";
import { AttachmentStorageNotConfiguredError, loadAttachmentData, loadAttachmentMeta } from "../services/attachment.js";
import { encodeRfc6266Filename } from "../services/attachment-store.js";

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
 * S3-backed rows (`object_key` set) redirect 302 to a presigned GetObject
 * URL (300s) instead of proxying bytes through Node — the server never
 * buffers the object. The 302 response is deliberately NOT long-cached
 * (`Cache-Control: private, no-cache`): every presigned URL is unique, so
 * caching the redirect would never hit and would only pollute caches; the
 * ETag/304 pre-check below is the cache story. Legacy bytea rows (the
 * pre-migration window) keep the old buffered response unchanged.
 *
 * Upload lives separately at `POST /api/v1/orgs/:orgId/attachments`
 * (Class B) because the uploader identity is org-scoped — see
 * api/orgs/attachments.ts.
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { id } = request.params;

    // Load metadata only — the ETag check runs off this, so a 304 cache hit
    // never touches S3 or the legacy bytea payload.
    const meta = await loadAttachmentMeta(app.db, id);
    if (!meta) {
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    // If-None-Match: cheap ETag check. id is content-stable (UUIDv4 + bytes
    // are immutable once written), so we never need to vary on anything else.
    const ifNoneMatch = request.headers["if-none-match"];
    const etag = `"${meta.id}"`;
    if (ifNoneMatch === etag) {
      return reply.status(304).send();
    }

    if (meta.objectKey) {
      const store = app.attachmentStore;
      if (!store) {
        // The row is S3-backed but this server has no s3 config — fail loud
        // rather than pretending the object is reachable.
        throw new AttachmentStorageNotConfiguredError();
      }
      const url = await store.presignGetUrl(meta.objectKey, { mimeType: meta.mimeType, filename: meta.filename });
      return reply.header("Cache-Control", "private, no-cache").header("ETag", etag).redirect(url);
    }

    // Legacy dual-track fallback: pre-migration rows still carry their bytes
    // inline. Unchanged response shape for the migration window.
    const data = await loadAttachmentData(app.db, id);
    if (!data) {
      // Deleted between the metadata read and now — vanishingly rare, but
      // surface it honestly rather than streaming an empty body.
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    reply
      .header("Content-Type", meta.mimeType)
      .header("Content-Length", meta.sizeBytes)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", etag)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `inline; filename="${encodeRfc6266Filename(meta.filename)}"`);
    return reply.send(data);
  });
}
