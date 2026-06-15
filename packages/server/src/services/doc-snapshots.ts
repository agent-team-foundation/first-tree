import {
  type AttachmentRef,
  attachmentRefSchema,
  documentContextSchema,
  MAX_MESSAGE_ATTACHMENT_REFS,
} from "@first-tree/shared";
import { BadRequestError } from "../errors.js";
import { type AttachmentReader, loadAttachmentMeta } from "./attachment.js";

/**
 * Server-side shape validation for `metadata.documentContext`.
 *
 * After the attachment-ref convergence the only thing left in
 * `documentContext` is the inert-chip `failedMentions` roster (the successful
 * captures are now generic `AttachmentRef`s in `metadata.attachments[]`, byte
 * validated by {@link validateMessageAttachmentRefs}). This function only
 * enforces the discriminated-union shape so a malformed roster is rejected
 * loudly rather than silently stored.
 *
 * Graceful degradation: a pre-cutover message carrying the legacy inline
 * `kind: "snapshot"` shape (`docs[].content`) no longer matches the schema, so
 * the parse fails. This validator runs only on the SEND path (new messages),
 * so a parse failure here is a genuine client bug worth surfacing; readers
 * (web) tolerate the legacy shape by falling back to no-preview.
 *
 * Throws `BadRequestError` on a malformed `documentContext`; a no-op when the
 * field is absent.
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
}

/**
 * Server-side bottom-line validation for `metadata.attachments[]` — the generic
 * attachment-ref roster (doc-preview is the first consumer; kind: "document").
 *
 * Runtime is the ref author, but the wire is untrusted: server confirms each
 * referenced blob actually exists and that the ref's declared `mimeType` /
 * `size` agree with the stored `attachments` row. This is the trust boundary
 * that keeps a buggy or malicious client from lodging a ref whose declared
 * metadata drifts from reality (which would mislead every reader / integrity
 * check). Integrity of the BYTES is verified client-side at render via
 * `ref.sha256`, so the server does not re-hash (zero DB change, no bytea read
 * on the hot send path).
 *
 * Deliberately does NOT check `uploaded_by == sender`: uploads record the
 * managing human's `humanAgentId`, while the message sender is the agent uuid —
 * the two are never equal, so that check would reject every normal send (see
 * proposal §5.3, verified against api/orgs/attachments.ts).
 *
 * Throws `BadRequestError` when the ref count exceeds the cap, or any ref's
 * attachment is missing / mime-mismatched / size-mismatched. A no-op when no
 * `attachments` field is present (the common case — most messages carry none).
 */
export async function validateMessageAttachmentRefs(
  db: AttachmentReader,
  metadata: Record<string, unknown> | undefined,
): Promise<void> {
  const refs = readAttachmentRefsStrict(metadata);
  if (refs.length === 0) return;

  if (refs.length > MAX_MESSAGE_ATTACHMENT_REFS) {
    throw new BadRequestError("Too many attachment references on a single message", {
      "attachment_ref.count": refs.length,
      "attachment_ref.limit": MAX_MESSAGE_ATTACHMENT_REFS,
    });
  }

  // Look up every referenced row in parallel (metadata only — no bytea).
  const rows = await Promise.all(refs.map((ref) => loadAttachmentMeta(db, ref.attachmentId)));

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const row = rows[i];
    if (!ref) continue;
    if (!row) {
      throw new BadRequestError("Attachment reference points at a non-existent attachment", {
        "attachment_ref.id": ref.attachmentId,
      });
    }
    if (row.mimeType !== ref.mimeType) {
      throw new BadRequestError("Attachment reference mimeType does not match the stored attachment", {
        "attachment_ref.id": ref.attachmentId,
        "attachment_ref.declared_mime": ref.mimeType,
        "attachment_ref.actual_mime": row.mimeType,
      });
    }
    if (row.sizeBytes !== ref.size) {
      throw new BadRequestError("Attachment reference size does not match the stored attachment", {
        "attachment_ref.id": ref.attachmentId,
        "attachment_ref.declared_size": ref.size,
        "attachment_ref.actual_size": row.sizeBytes,
      });
    }
  }
}

/**
 * Read `metadata.attachments[]`, rejecting a present-but-malformed array as a
 * client bug. The render-side `attachmentRefsFromMetadata` reader silently drops
 * bad entries; on the send path we want a loud failure instead so a misbehaving
 * runtime can't ship a half-broken roster. Each entry is validated with the full
 * `attachmentRefSchema` (uuid id + sha256 length + field types), not just the
 * hand-rolled `isAttachmentRef` guard, so any schema-invalid ref is rejected
 * with a clean 400 rather than slipping through.
 */
function readAttachmentRefsStrict(metadata: Record<string, unknown> | undefined): AttachmentRef[] {
  if (!metadata) return [];
  const raw = metadata.attachments;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestError("metadata.attachments must be an array of attachment references");
  }
  const refs: AttachmentRef[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = attachmentRefSchema.safeParse(raw[i]);
    if (!parsed.success) {
      throw new BadRequestError("metadata.attachments contains a malformed attachment reference", {
        "attachment_ref.index": i,
        "attachment_ref.parse_error": parsed.error.message.slice(0, 200),
      });
    }
    refs.push(parsed.data);
  }
  return refs;
}
