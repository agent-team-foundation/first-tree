import { isInlineSafeImage } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyReply } from "fastify";
import type { DownloadableAttachment } from "../services/attachment.js";

/** Strip control chars / quotes for a safe Content-Disposition filename. */
function dispositionFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "attachment";
}

/**
 * Write hardened download headers and send the bytes (C2). Only the
 * inline-safe image allow-list (png/jpeg/gif/webp) is served inline so
 * `<img>`/blob rendering works; everything else — including `image/svg+xml`,
 * which can carry script — is forced to download with a neutral content type
 * and `nosniff`, so a malicious payload can never execute in the Hub origin.
 *
 * Bytes are sent as a single Buffer (≤ the per-file cap). True chunked
 * streaming isn't possible from a PG `bytea` column (postgres-js reads the
 * value whole); the size cap bounds memory instead.
 */
export function sendAttachmentResponse(reply: FastifyReply, att: DownloadableAttachment): void {
  const inline = isInlineSafeImage(att.mime);
  reply.header("Content-Type", inline ? att.mime : "application/octet-stream");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${dispositionFilename(att.filename)}"`,
  );
  reply.header("Content-Length", String(att.size));
  reply.header("Cache-Control", "private, max-age=3600");
  reply.send(att.bytes);
}
