import { attachmentRefsFromMetadata, isImageBatchRefContent, isImageRefContent } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { attachmentReferences } from "../db/schema/attachment-references.js";
import { attachments } from "../db/schema/attachments.js";
import { BadRequestError } from "../errors.js";
import { createLogger } from "../observability/logger.js";
import type { ObjectStorage } from "./object-storage.js";

const log = createLogger("AttachmentReferences");

/** `Database` or an open transaction — both satisfy the query surface used here. */
type ReferenceWriter = Pick<Database, "select" | "selectDistinct" | "insert" | "delete" | "update">;

function asMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // Structural narrow only — jsonb columns surface as `unknown`.
  return value as Record<string, unknown>;
}

/**
 * THE single source of truth for attachment-reference discovery on a
 * message. Every shape that can carry an `attachments.id` lives here:
 *
 * - `content` single image ref (`{ imageId, ... }`, format "file")
 * - `content` batch ref (`{ attachments: [{ imageId, ... }] }`, format "file")
 * - `metadata.attachments[]` generic refs (`{ attachmentId, ... }`)
 *
 * Reference writes (send/edit), the migration backfill, and the orphan
 * sweep's verify scan all derive from this function — a future reference
 * shape must be added here and nowhere else. Agent avatars are NOT
 * attachment references (separate storage namespace; see db/schema/agents.ts).
 */
export function collectAttachmentIds(content: unknown, metadata: unknown): Set<string> {
  const ids = new Set<string>();
  if (isImageRefContent(content)) {
    ids.add(content.imageId);
  } else if (isImageBatchRefContent(content)) {
    for (const image of content.attachments) {
      ids.add(image.imageId);
    }
  }
  for (const ref of attachmentRefsFromMetadata(asMetadataRecord(metadata))) {
    ids.add(ref.attachmentId);
  }
  return ids;
}

export type SyncMessageAttachmentReferencesInput = {
  messageId: string;
  /** Organization owning the chat the message lives in. */
  organizationId: string;
  content: unknown;
  metadata: unknown;
};

export type SyncMessageAttachmentReferencesResult = {
  /**
   * Attachments this sync CAS-ed to `deleting` because the message dropped
   * their last remaining reference. The caller destroys them after commit
   * via `destroyDeletingAttachments` (the sweep is the crash backstop).
   */
  removedForDeletion: string[];
};

/**
 * Reconcile the `attachment_references` ledger with what a message
 * actually references — called INSIDE the message write transaction, right
 * after the row insert/update, for both send (no prior edges) and edit.
 *
 * Locking protocol: one `SELECT ... ORDER BY id FOR UPDATE` over the whole
 * touched set (added ∪ removed). Every reference/deletion path locks
 * attachment rows in ascending-id order in a single statement, so lock
 * acquisition forms no cycles; the sweep's SKIP LOCKED passes never wait.
 * After locking, added references are validated (row exists, `stored`,
 * same-org or legacy NULL org) — a `pending` upload or `deleting`
 * tombstone cannot gain references, which is what makes the tombstone CAS
 * race-free in the other direction.
 */
export async function syncMessageAttachmentReferences(
  tx: ReferenceWriter,
  input: SyncMessageAttachmentReferencesInput,
): Promise<SyncMessageAttachmentReferencesResult> {
  const target = collectAttachmentIds(input.content, input.metadata);
  const currentRows = await tx
    .select({ attachmentId: attachmentReferences.attachmentId })
    .from(attachmentReferences)
    .where(eq(attachmentReferences.messageId, input.messageId));
  const current = new Set(currentRows.map((row) => row.attachmentId));

  const added = [...target].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !target.has(id));
  if (added.length === 0 && removed.length === 0) {
    return { removedForDeletion: [] };
  }

  const touched = [...new Set([...added, ...removed])].sort();
  const lockedRows = await tx
    .select({
      id: attachments.id,
      state: attachments.state,
      organizationId: attachments.organizationId,
    })
    .from(attachments)
    .where(inArray(attachments.id, touched))
    .orderBy(attachments.id)
    .for("update");
  const lockedById = new Map(lockedRows.map((row) => [row.id, row]));

  for (const id of added) {
    const row = lockedById.get(id);
    if (!row) {
      throw new BadRequestError(`Message references unknown attachment "${id}"`);
    }
    if (row.state !== "stored") {
      // `pending` = still uploading, `deleting` = tombstoned — neither is
      // referenceable, and rejecting here closes the reference-vs-delete race.
      throw new BadRequestError(`Message references attachment "${id}" which is not available`);
    }
    if (row.organizationId !== null && row.organizationId !== input.organizationId) {
      throw new BadRequestError(`Message references attachment "${id}" from a different organization`);
    }
  }

  if (added.length > 0) {
    await tx
      .insert(attachmentReferences)
      .values(added.map((attachmentId) => ({ attachmentId, messageId: input.messageId })))
      .onConflictDoNothing();
  }

  const removedForDeletion: string[] = [];
  if (removed.length > 0) {
    await tx
      .delete(attachmentReferences)
      .where(
        and(eq(attachmentReferences.messageId, input.messageId), inArray(attachmentReferences.attachmentId, removed)),
      );
    // Which of the removed attachments now have zero edges? Their rows are
    // locked above, so no concurrent send can add an edge until we commit.
    const stillReferenced = new Set(
      (
        await tx
          .selectDistinct({ attachmentId: attachmentReferences.attachmentId })
          .from(attachmentReferences)
          .where(inArray(attachmentReferences.attachmentId, removed))
      ).map((row) => row.attachmentId),
    );
    const orphaned = removed.filter((id) => !stillReferenced.has(id) && lockedById.get(id)?.state === "stored");
    if (orphaned.length > 0) {
      const tombstoned = await tx
        .update(attachments)
        .set({ state: "deleting" })
        .where(and(inArray(attachments.id, orphaned), eq(attachments.state, "stored")))
        .returning({ id: attachments.id });
      removedForDeletion.push(...tombstoned.map((row) => row.id));
    }
  }

  return { removedForDeletion };
}

/**
 * Destroy `deleting` tombstones: remove the payload object, then the row.
 * Best-effort and idempotent — any failure leaves the tombstone for the
 * background sweep's retry pass. Rows whose payload never reached object
 * storage (legacy bytea) skip the object delete; when object storage is
 * unconfigured the tombstone is left in place so the object is not leaked.
 */
export async function destroyDeletingAttachments(
  db: Database,
  objectStorage: ObjectStorage | null,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    try {
      const [row] = await db
        .select({ objectKey: attachments.objectKey })
        .from(attachments)
        .where(and(eq(attachments.id, id), eq(attachments.state, "deleting")))
        .limit(1);
      if (!row) continue;
      if (row.objectKey) {
        if (!objectStorage) {
          log.warn({ attachmentId: id }, "object storage unavailable; leaving tombstone for the sweep");
          continue;
        }
        await objectStorage.deleteObject(row.objectKey);
      }
      await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.state, "deleting")));
    } catch (error) {
      log.warn({ err: error, attachmentId: id }, "attachment destroy failed; the sweep will retry");
    }
  }
}
