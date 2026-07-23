import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { attachmentReferences } from "../db/schema/attachment-references.js";
import { attachments } from "../db/schema/attachments.js";
import { createLogger } from "../observability/logger.js";
import { destroyDeletingAttachments } from "./attachment-references.js";
import type { ObjectStorage } from "./object-storage.js";

const log = createLogger("AttachmentSweep");

export type AttachmentSweepOptions = {
  /** Age after which an unreferenced `stored` attachment is an orphan (governed default 24h). */
  orphanGraceSeconds: number;
  /** Age after which a `pending` reservation whose upload never finalized is reclaimed. */
  pendingTtlSeconds: number;
  /** Per-pass claim cap; bounds lock hold time and the verify-scan candidate set. */
  batchSize?: number;
};

export type AttachmentSweepResult = {
  pendingReclaimed: number;
  orphansDeleted: number;
  /** Orphan candidates saved by the verify scan (referenced in message text but missing edges). */
  orphansVetoed: number;
  tombstonesCleared: number;
};

/**
 * Orphan / reservation / tombstone sweep. Runs concurrently on every
 * replica with no leader election: every pass claims its batch with
 * `FOR UPDATE SKIP LOCKED` (the same claim shape as the cron scheduler),
 * transitions are CAS-guarded, and object deletion is idempotent — two
 * replicas sweeping at once just split the batch.
 *
 * Three passes per run:
 *
 * 1. expired `pending` reservations  → tombstone → destroy
 * 2. aged zero-edge `stored` rows    → VERIFY SCAN → tombstone → destroy
 * 3. leftover `deleting` tombstones  → destroy (crash retry)
 *
 * The verify scan is the load-bearing safety net, not an optimization: in
 * the window between deploying this feature and running the
 * `migrate:attachments` backfill, EVERY pre-existing attachment has zero
 * edges — deleting on the edge ledger alone would destroy referenced
 * data. Before tombstoning, candidates are matched as literal text against
 * `messages.content`/`metadata` (one scan for the whole batch via
 * `unnest`); any hit is vetoed and logged. A real reference always
 * contains the id verbatim in one of those two jsonb columns, so the scan
 * can only err toward keeping (false positives keep an orphan alive until
 * the backfill records real edges; false negatives cannot happen).
 */
export async function sweepAttachments(
  db: Database,
  objectStorage: ObjectStorage | null,
  opts: AttachmentSweepOptions,
): Promise<AttachmentSweepResult> {
  const batchSize = opts.batchSize ?? 50;
  const result: AttachmentSweepResult = {
    pendingReclaimed: 0,
    orphansDeleted: 0,
    orphansVetoed: 0,
    tombstonesCleared: 0,
  };

  // Pass 1 — expired pending reservations (crashed/abandoned uploads).
  const pendingCutoff = new Date(Date.now() - opts.pendingTtlSeconds * 1000);
  const expiredPending = await db.transaction(async (tx) => {
    const claimed = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.state, "pending"), lt(attachments.createdAt, pendingCutoff)))
      .orderBy(attachments.createdAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });
    const ids = claimed.map((row) => row.id);
    if (ids.length > 0) {
      await tx.update(attachments).set({ state: "deleting" }).where(inArray(attachments.id, ids));
    }
    return ids;
  });
  await destroyDeletingAttachments(db, objectStorage, expiredPending);
  result.pendingReclaimed = expiredPending.length;

  // Pass 2 — aged zero-edge stored rows, with the verify-scan veto.
  const orphanCutoff = new Date(Date.now() - opts.orphanGraceSeconds * 1000);
  const orphans = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.state, "stored"),
          lt(attachments.createdAt, orphanCutoff),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(attachmentReferences)
              .where(eq(attachmentReferences.attachmentId, attachments.id)),
          ),
        ),
      )
      .orderBy(attachments.createdAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });
    const candidateIds = candidates.map((row) => row.id);
    if (candidateIds.length === 0) {
      return { deleted: [] as string[], vetoed: 0 };
    }

    // One scan of `messages` for the whole batch: an id referenced anywhere
    // in content/metadata jsonb appears as a literal substring of its text
    // form. Candidate attachment rows are locked above, so a concurrent
    // send targeting one of them blocks until this transaction commits.
    const vetoRows = await tx.execute(sql`
      SELECT DISTINCT c.id
      FROM jsonb_array_elements_text(${JSON.stringify(candidateIds)}::jsonb) AS c(id)
      JOIN messages m
        ON m.content::text LIKE '%' || c.id || '%'
        OR m.metadata::text LIKE '%' || c.id || '%'
    `);
    const vetoed = new Set<string>();
    for (const row of vetoRows) {
      if (typeof row === "object" && row !== null && "id" in row && typeof row.id === "string") {
        vetoed.add(row.id);
      }
    }
    if (vetoed.size > 0) {
      log.warn(
        { attachmentIds: [...vetoed] },
        "orphan sweep vetoed candidates referenced in message text without ledger edges (run migrate:attachments to backfill)",
      );
    }
    const survivors = candidateIds.filter((id) => !vetoed.has(id));
    if (survivors.length > 0) {
      await tx
        .update(attachments)
        .set({ state: "deleting" })
        .where(and(inArray(attachments.id, survivors), eq(attachments.state, "stored")));
    }
    return { deleted: survivors, vetoed: vetoed.size };
  });
  await destroyDeletingAttachments(db, objectStorage, orphans.deleted);
  result.orphansDeleted = orphans.deleted.length;
  result.orphansVetoed = orphans.vetoed;

  // Pass 3 — leftover tombstones (crashes between CAS and destroy, or
  // storage that was unavailable on an earlier attempt).
  const tombstones = await db.transaction(async (tx) => {
    const claimed = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.state, "deleting"))
      .orderBy(attachments.createdAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });
    return claimed.map((row) => row.id);
  });
  await destroyDeletingAttachments(db, objectStorage, tombstones);
  result.tombstonesCleared = tombstones.length;

  return result;
}
