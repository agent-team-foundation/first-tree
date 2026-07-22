import { Readable } from "node:stream";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { createLogger } from "../observability/index.js";
import type { AttachmentStore } from "./attachment-store.js";

const log = createLogger("attachment-migration");

/**
 * Core loop of `scripts/migrate-attachments-to-s3.ts`, factored here (src/)
 * so the product test suite can drive it directly — the script itself is a
 * thin env-parsing / advisory-lock wrapper and is not typechecked by the
 * server tsconfig (`rootDir: src`).
 *
 * Drains the legacy dual-track: every row with `data NOT NULL AND
 * object_key IS NULL` gets its bytes uploaded to S3 and — in the same
 * per-row transaction — `object_key` set, `org_id` backfilled from
 * `uploaded_by → agents.organization_id`, and `data` nulled. Rows are
 * processed oldest-first in batches; a failed row keeps its `data` and the
 * next run resumes exactly there (idempotent: re-upload overwrites the same
 * key, the UPDATE's `object_key IS NULL` guard no-ops on completed rows).
 */
export const ATTACHMENT_S3_MIGRATION_BATCH_SIZE = 100;

export type AttachmentS3MigrationSummary = {
  scanned: number;
  migrated: number;
  failed: number;
};

export type AttachmentS3MigrationOptions = {
  batchSize?: number;
  /** Called after each batch with the running totals. */
  onProgress?: (summary: AttachmentS3MigrationSummary) => void;
};

export async function migrateLegacyAttachmentsToS3(
  db: Database,
  store: AttachmentStore,
  options: AttachmentS3MigrationOptions = {},
): Promise<AttachmentS3MigrationSummary> {
  const batchSize = options.batchSize ?? ATTACHMENT_S3_MIGRATION_BATCH_SIZE;
  const summary: AttachmentS3MigrationSummary = { scanned: 0, migrated: 0, failed: 0 };

  for (;;) {
    const batch = await db
      .select({
        id: attachments.id,
        uploadedBy: attachments.uploadedBy,
        mimeType: attachments.mimeType,
        data: attachments.data,
      })
      .from(attachments)
      .where(and(isNotNull(attachments.data), isNull(attachments.objectKey)))
      .orderBy(asc(attachments.createdAt))
      .limit(batchSize);
    if (batch.length === 0) break;

    for (const row of batch) {
      summary.scanned += 1;
      if (!row.data) continue; // racing a concurrent writer — skip, next run settles it
      try {
        await migrateOneRow(db, store, {
          id: row.id,
          uploadedBy: row.uploadedBy,
          mimeType: row.mimeType,
          data: row.data,
        });
        summary.migrated += 1;
      } catch (err) {
        summary.failed += 1;
        log.warn({ err, attachmentId: row.id }, "attachment migration failed for row; kept bytea for a rerun");
      }
    }
    options.onProgress?.({ ...summary });
  }

  return summary;
}

async function migrateOneRow(
  db: Database,
  store: AttachmentStore,
  row: { id: string; uploadedBy: string; mimeType: string; data: Buffer },
): Promise<void> {
  // org backfill: uploaded_by → agents.organization_id. NULL when the
  // uploader row is gone (agent deleted) — downloads key off object_key, so
  // an unresolved org only means the row stays out of quota accounting.
  const [uploader] = await db
    .select({ organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.uuid, row.uploadedBy))
    .limit(1);
  const orgId = uploader?.organizationId ?? null;

  const objectKey = `attachments/${orgId ?? "_unknown"}/${row.id}`;

  // Readable.from([buffer]) — NOT Readable.from(buffer): a bare Buffer is
  // iterated per byte, which would push one-byte chunks through multipart.
  await store.upload(objectKey, Readable.from([row.data]), row.mimeType);

  await db.transaction(async (tx) => {
    await tx
      .update(attachments)
      .set({ objectKey, orgId, data: null })
      .where(and(eq(attachments.id, row.id), isNull(attachments.objectKey)));
  });
}
