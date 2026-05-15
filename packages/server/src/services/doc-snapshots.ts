import { createHash } from "node:crypto";
import {
  documentContextSchema,
  MAX_DOC_SNAPSHOT_BYTES,
  MAX_TOTAL_DOC_SNAPSHOT_BYTES,
} from "@agent-team-foundation/first-tree-hub-shared";
import { BadRequestError } from "../errors.js";

/**
 * Server-side bottom-line validation for `metadata.documentContext`.
 *
 * Runtime is the snapshot author, but content arrives over the wire — server
 * still has to verify byte budgets and recompute sha256 so a buggy or
 * malicious client cannot lodge a doc whose declared hash drifts from its
 * actual content. Shape validation (path / docs[] cap / kind discriminator)
 * lives in the shared schema; this file owns the byte-counted and
 * cryptographic checks that schemas cannot express.
 *
 * Returns the validated DocumentContext for the caller to store, or
 * `undefined` if no `documentContext` was provided.
 *
 * Why throw BadRequestError instead of silently stripping: snapshot data
 * comes from a trusted runtime; a schema mismatch typically signals a
 * client bug, and surfacing it loudly is more useful than hiding it.
 */
export function validateDocumentContext(metadata: Record<string, unknown> | undefined): void {
  if (!metadata) return;
  const raw = metadata.documentContext;
  if (raw === undefined || raw === null) return;

  const parsed = documentContextSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError("Invalid documentContext", {
      "doc_snapshot.parse_error": parsed.error.message.slice(0, 200),
    });
  }
  const ctx = parsed.data;
  if (ctx.kind !== "snapshot") return;

  let totalBytes = 0;
  for (const doc of ctx.docs) {
    const actualBytes = Buffer.byteLength(doc.content, "utf8");
    if (actualBytes > MAX_DOC_SNAPSHOT_BYTES) {
      throw new BadRequestError("Document snapshot exceeds per-file byte budget", {
        "doc_snapshot.path": doc.path,
        "doc_snapshot.actual_bytes": actualBytes,
        "doc_snapshot.limit_bytes": MAX_DOC_SNAPSHOT_BYTES,
      });
    }
    if (doc.size !== actualBytes) {
      throw new BadRequestError("Document snapshot size does not match content", {
        "doc_snapshot.path": doc.path,
        "doc_snapshot.declared_size": doc.size,
        "doc_snapshot.actual_size": actualBytes,
      });
    }
    const actualSha = createHash("sha256").update(doc.content, "utf8").digest("hex");
    if (actualSha !== doc.sha256) {
      throw new BadRequestError("Document snapshot sha256 does not match content", {
        "doc_snapshot.path": doc.path,
      });
    }
    totalBytes += actualBytes;
  }
  if (totalBytes > MAX_TOTAL_DOC_SNAPSHOT_BYTES) {
    throw new BadRequestError("Total document snapshot bytes exceed per-message budget", {
      "doc_snapshot.total_bytes": totalBytes,
      "doc_snapshot.limit_bytes": MAX_TOTAL_DOC_SNAPSHOT_BYTES,
    });
  }
}
