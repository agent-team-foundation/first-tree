import { Readable } from "node:stream";
import { and, asc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { createLogger } from "../observability/logger.js";
import { collectAttachmentIds } from "./attachment-references.js";
import { attachmentObjectKey, avatarObjectKey, type ObjectStorage } from "./object-storage.js";

const log = createLogger("AttachmentMigration");

const MESSAGE_PAGE = 500;
const BLOB_BATCH = 8;
const BLOB_PARALLEL = 4;

export type AttachmentMigrationStats = {
  organizationsBackfilled: number;
  organizationlessRemaining: number;
  messagesScanned: number;
  edgesInserted: number;
  attachmentsMoved: number;
  attachmentsSkipped: number;
  avatarsMoved: number;
  avatarsSkipped: number;
  attachmentsRemaining: number;
  avatarsRemaining: number;
};

function affectedCount(result: unknown): number {
  // postgres-js returns a RowList — an array carrying a `count` property
  // with the command's affected-row count.
  if (typeof result === "object" && result !== null && "count" in result) {
    const count = (result as { count?: unknown }).count;
    if (typeof count === "number") return count;
  }
  return 0;
}

/**
 * Move every inline binary payload (attachments.data, agents.avatar_image_data)
 * into object storage and backfill governance metadata. Five idempotent
 * phases — rerunning after a crash, or to converge references written
 * concurrently with the message scan, is always safe:
 *
 *   A. attachments.organization_id from the uploader's agent row
 *   B. attachment_references from message content/metadata (same
 *      `collectAttachmentIds` discovery the live write path uses; dangling
 *      historic ids and tombstoned rows are filtered by the join)
 *   C. attachment payloads → `attachments/<id>` (atomic key+NULL swap;
 *      rows the sweep tombstoned mid-flight are skipped and the
 *      freshly-written object is removed again)
 *   D. avatar payloads → `avatars/<uuid>`
 *   E. verify — counts of payloads still inline
 *
 * Runs against a live server: new uploads already land in object storage,
 * the download path falls through to the deterministic key mid-migration,
 * and the orphan sweep's verify scan keeps pre-backfill attachments alive
 * until phase B records their edges.
 */
export async function migrateAttachmentsToObjectStorage(
  db: Database,
  storage: ObjectStorage,
): Promise<AttachmentMigrationStats> {
  // ── Phase A: organization backfill ─────────────────────────────────
  const orgBackfill = await db.execute(sql`
    UPDATE attachments
    SET organization_id = agents.organization_id
    FROM agents
    WHERE attachments.organization_id IS NULL
      AND agents.uuid = attachments.uploaded_by
  `);
  const [orgless] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(attachments)
    .where(sql`${attachments.organizationId} IS NULL`);
  const organizationsBackfilled = affectedCount(orgBackfill);
  const organizationlessRemaining = Number(orgless?.count ?? 0);
  log.info(
    { organizationsBackfilled, organizationlessRemaining },
    "phase A: organization_id backfill (remaining NULL rows are quota-exempt legacy)",
  );

  // ── Phase B: reference-ledger backfill ─────────────────────────────
  let edgesInserted = 0;
  let messagesScanned = 0;
  let cursor = "";
  for (;;) {
    const page = await db
      .select({ id: messages.id, content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(gt(messages.id, cursor))
      .orderBy(asc(messages.id))
      .limit(MESSAGE_PAGE);
    if (page.length === 0) break;
    messagesScanned += page.length;
    cursor = page[page.length - 1]?.id ?? cursor;

    const pairs: Array<{ attachment_id: string; message_id: string }> = [];
    for (const row of page) {
      for (const attachmentId of collectAttachmentIds(row.content, row.metadata)) {
        pairs.push({ attachment_id: attachmentId, message_id: row.id });
      }
    }
    if (pairs.length === 0) continue;
    const inserted = await db.execute(sql`
      INSERT INTO attachment_references (attachment_id, message_id)
      SELECT p.attachment_id, p.message_id
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
        AS p(attachment_id text, message_id text)
      JOIN attachments a ON a.id = p.attachment_id AND a.state != 'deleting'
      ON CONFLICT DO NOTHING
    `);
    edgesInserted += affectedCount(inserted);
  }
  log.info({ messagesScanned, edgesInserted }, "phase B: reference-ledger backfill");

  // ── Phase C: attachment payloads → object storage ──────────────────
  let attachmentsMoved = 0;
  let attachmentsSkipped = 0;
  for (;;) {
    const batch = await db
      .select({
        id: attachments.id,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        data: attachments.data,
      })
      .from(attachments)
      .where(and(isNotNull(attachments.data), eq(attachments.state, "stored")))
      .orderBy(asc(attachments.id))
      .limit(BLOB_BATCH);
    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += BLOB_PARALLEL) {
      await Promise.all(
        batch.slice(i, i + BLOB_PARALLEL).map(async (row) => {
          const data = row.data;
          if (!data) return;
          const key = attachmentObjectKey(row.id);
          if (row.sizeBytes !== data.byteLength) {
            log.warn(
              { attachmentId: row.id, sizeBytes: row.sizeBytes, payloadBytes: data.byteLength },
              "size_bytes disagrees with payload; normalizing to the payload",
            );
          }
          await storage.putObjectStream(key, Readable.from([data]), {
            contentLength: data.byteLength,
            contentType: row.mimeType,
          });
          const updated = await db
            .update(attachments)
            .set({ objectKey: key, data: null, sizeBytes: data.byteLength })
            .where(and(eq(attachments.id, row.id), eq(attachments.state, "stored"), isNotNull(attachments.data)))
            .returning({ id: attachments.id });
          if (updated.length === 0) {
            // Tombstoned (or already migrated by a parallel run) mid-flight —
            // remove the object we just wrote so nothing leaks unreferenced.
            await storage.deleteObject(key);
            attachmentsSkipped += 1;
            return;
          }
          attachmentsMoved += 1;
        }),
      );
    }
  }
  log.info({ attachmentsMoved, attachmentsSkipped }, "phase C: attachment payloads moved");

  // ── Phase D: avatar payloads → object storage ──────────────────────
  let avatarsMoved = 0;
  let avatarsSkipped = 0;
  for (;;) {
    const batch = await db
      .select({ uuid: agents.uuid, mime: agents.avatarImageMime, data: agents.avatarImageData })
      .from(agents)
      .where(isNotNull(agents.avatarImageData))
      .orderBy(asc(agents.uuid))
      .limit(BLOB_BATCH);
    if (batch.length === 0) break;

    for (const row of batch) {
      const data = row.data;
      if (!data) continue;
      if (!row.mime) {
        // mime is NULL iff data is NULL by contract; a violating row cannot
        // be served today either — clear it rather than migrating garbage.
        log.warn({ agentUuid: row.uuid }, "avatar payload without mime; clearing without migrating");
        await db
          .update(agents)
          .set({ avatarImageData: null })
          .where(and(eq(agents.uuid, row.uuid), isNotNull(agents.avatarImageData)));
        avatarsSkipped += 1;
        continue;
      }
      const key = avatarObjectKey(row.uuid);
      await storage.putObjectStream(key, Readable.from([data]), {
        contentLength: data.byteLength,
        contentType: row.mime,
      });
      const updated = await db
        .update(agents)
        .set({ avatarObjectKey: key, avatarImageData: null })
        .where(and(eq(agents.uuid, row.uuid), isNotNull(agents.avatarImageData)))
        .returning({ uuid: agents.uuid });
      if (updated.length === 0) {
        await storage.deleteObject(key);
        avatarsSkipped += 1;
      } else {
        avatarsMoved += 1;
      }
    }
  }
  log.info({ avatarsMoved, avatarsSkipped }, "phase D: avatar payloads moved");

  // ── Phase E: verify ────────────────────────────────────────────────
  const [attachmentsLeft] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(attachments)
    .where(and(isNotNull(attachments.data), ne(attachments.state, "deleting")));
  const [avatarsLeft] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(agents)
    .where(isNotNull(agents.avatarImageData));
  const attachmentsRemaining = Number(attachmentsLeft?.count ?? 0);
  const avatarsRemaining = Number(avatarsLeft?.count ?? 0);
  log.info({ attachmentsRemaining, avatarsRemaining }, "phase E: inline payloads remaining");

  return {
    organizationsBackfilled,
    organizationlessRemaining,
    messagesScanned,
    edgesInserted,
    attachmentsMoved,
    attachmentsSkipped,
    avatarsMoved,
    avatarsSkipped,
    attachmentsRemaining,
    avatarsRemaining,
  };
}
