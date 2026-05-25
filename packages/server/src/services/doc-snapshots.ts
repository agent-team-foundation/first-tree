import { createHash } from "node:crypto";
import {
  documentContextSchema,
  MAX_DOC_SNAPSHOT_BYTES,
  MAX_TOTAL_DOC_SNAPSHOT_BYTES,
  parseWorkspaceDocKey,
} from "@first-tree/shared";
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
 *
 * `chatScope` (optional) enables cross-agent provenance authz: a snapshot key
 * shaped like a global cross key `<ownerSlug>/<chatId>/<rel>` whose chatId
 * segment matches the message's chat must name an owner that is a participant
 * of that chat. This is defense-in-depth on top of the runtime's structural
 * fence — a compromised runtime cannot embed (and broadcast) a non-participant
 * agent's workspace doc. Self / legacy bare keys carry no owner segment for
 * this chat and are unaffected. When omitted (other callers / tests), the
 * provenance check is skipped.
 */
export function validateDocumentContext(
  metadata: Record<string, unknown> | undefined,
  chatScope?: { chatId: string; participantSlugs: ReadonlySet<string> },
): void {
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
    if (chatScope) {
      const key = parseWorkspaceDocKey(doc.path);
      if (key) {
        const ownerIsParticipant = chatScope.participantSlugs.has(key.agentSlug.toLowerCase());
        if (key.chatId === chatScope.chatId) {
          // Cross-agent global key for THIS chat — the owner must be a speaker
          // participant, else a doc from a non-member's workspace would be
          // broadcast into the chat.
          if (!ownerIsParticipant) {
            throw new BadRequestError("Document snapshot references a non-participant agent workspace", {
              "doc_snapshot.path": doc.path,
              "doc_snapshot.owner_slug": key.agentSlug,
            });
          }
        } else if (ownerIsParticipant) {
          // Owner-shaped global key naming a DIFFERENT chat. A participant-owned
          // key whose chat segment isn't this chat would pull another chat's
          // private workspace doc past the `workspaces/*/<currentChatId>/` fence
          // — reject it (review P1). A deep SELF path whose first segment isn't
          // a participant slug (e.g. `docs/api/design.md`) is left alone.
          throw new BadRequestError("Document snapshot references another chat's agent workspace", {
            "doc_snapshot.path": doc.path,
            "doc_snapshot.owner_slug": key.agentSlug,
            "doc_snapshot.key_chat_id": key.chatId,
          });
        }
      }
    }
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
