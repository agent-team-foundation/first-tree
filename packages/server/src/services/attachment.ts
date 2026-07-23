import { randomUUID } from "node:crypto";
import { ATTACHMENT_ERROR_CODES, MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { attachments } from "../db/schema/attachments.js";
import { BadRequestError, UnprocessableError } from "../errors.js";
import { attachmentObjectKey } from "./object-storage.js";

/**
 * Attachment metadata service.
 *
 * Upload is reservation-first (see `reserveAttachment`): the row is inserted
 * in state `pending` BEFORE any byte reaches object storage, which makes the
 * quota reservation durable, then flipped to `stored` once the payload is
 * verified (`finalizeAttachment`). Reads:
 *
 * - `loadAttachmentMeta` looks up by id WITHOUT the legacy `bytea` payload;
 *   returns `null` on miss so the route layer can emit a 404 cleanly. The
 *   download route runs the ETag check off the metadata so a cache hit
 *   (304) never touches the payload.
 * - `loadAttachmentData` fetches just the legacy `bytea` payload — only
 *   used for rows the migration command has not moved to object storage.
 *
 * Download authorization is a capability model handled at the route layer:
 * a valid user JWT plus knowledge of the unguessable id. The service holds
 * no ACL logic.
 */

export type AttachmentRow = typeof attachments.$inferSelect;

/** Everything in `AttachmentRow` except the legacy `bytea` payload. */
export type AttachmentMeta = Omit<AttachmentRow, "data">;

/** A select-capable executor — `Database` or a transaction both satisfy it, so
 *  read helpers can run inside a caller's open transaction. */
export type AttachmentReader = Pick<Database, "select">;

export type OrgAttachmentQuota = {
  maxTotalBytes: number;
  maxObjectCount: number;
};

export type ReserveAttachmentInput = {
  organizationId: string;
  mimeType: string;
  filename: string;
  /** Exact payload size from the request's Content-Length. */
  sizeBytes: number;
  /** `agents.uuid` of the uploader; humans pass their humanAgentId. */
  uploadedBy: string;
  quota: OrgAttachmentQuota;
};

/**
 * Reserve quota and create the `pending` attachment row.
 *
 * Runs in one transaction holding the per-org advisory xact lock (same
 * two-int form as the landing-campaign quota locks), so concurrent uploads
 * of one org serialize on admission and cannot jointly overshoot the
 * quota. Release paths (sweep, delete) take no lock: a concurrent decrease
 * can only make this check conservative, never over-admit.
 *
 * Throws `UnprocessableError` with the stable `ATTACHMENT_QUOTA_EXCEEDED`
 * wire code when either the org byte quota or object-count quota would be
 * exceeded. Input validation errors are `BadRequestError`.
 */
export async function reserveAttachment(db: Database, input: ReserveAttachmentInput): Promise<AttachmentMeta> {
  if (input.sizeBytes <= 0) {
    throw new BadRequestError("Attachment is empty");
  }
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  if (input.mimeType.trim().length === 0) {
    throw new BadRequestError("Attachment mime type is required");
  }
  if (input.filename.trim().length === 0) {
    throw new BadRequestError("Attachment filename is required");
  }

  const id = randomUUID();
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('attachment_quota'), hashtext(${input.organizationId}))`,
    );
    const [usage] = await tx
      .select({
        totalBytes: sql<string>`COALESCE(SUM(${attachments.sizeBytes}), 0)`,
        objectCount: sql<string>`COUNT(*)`,
      })
      .from(attachments)
      .where(
        and(eq(attachments.organizationId, input.organizationId), inArray(attachments.state, ["pending", "stored"])),
      );
    const totalBytes = Number(usage?.totalBytes ?? 0);
    const objectCount = Number(usage?.objectCount ?? 0);
    if (totalBytes + input.sizeBytes > input.quota.maxTotalBytes) {
      throw new UnprocessableError(
        `Organization attachment storage quota exceeded (${totalBytes} of ${input.quota.maxTotalBytes} bytes used; upload is ${input.sizeBytes} bytes)`,
        { code: ATTACHMENT_ERROR_CODES.quotaExceeded, "attachment.quota.dimension": "bytes" },
      );
    }
    if (objectCount + 1 > input.quota.maxObjectCount) {
      throw new UnprocessableError(
        `Organization attachment count quota exceeded (${objectCount} of ${input.quota.maxObjectCount} objects used)`,
        { code: ATTACHMENT_ERROR_CODES.quotaExceeded, "attachment.quota.dimension": "count" },
      );
    }

    const [row] = await tx
      .insert(attachments)
      .values({
        id,
        organizationId: input.organizationId,
        mimeType: input.mimeType,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        objectKey: attachmentObjectKey(id),
        state: "pending",
        data: null,
        uploadedBy: input.uploadedBy,
      })
      .returning({
        id: attachments.id,
        organizationId: attachments.organizationId,
        mimeType: attachments.mimeType,
        filename: attachments.filename,
        sizeBytes: attachments.sizeBytes,
        objectKey: attachments.objectKey,
        state: attachments.state,
        uploadedBy: attachments.uploadedBy,
        createdAt: attachments.createdAt,
      });
    if (!row) {
      throw new Error("Attachment reservation insert returned no row");
    }
    return row;
  });
}

/**
 * CAS the reservation to `stored` after the payload is verified in object
 * storage. Returns `false` when the row is no longer `pending` — i.e. the
 * upload outlived the pending TTL and the sweep reclaimed the reservation;
 * the caller must then delete the freshly-written object.
 */
export async function finalizeAttachment(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(attachments)
    .set({ state: "stored" })
    .where(and(eq(attachments.id, id), eq(attachments.state, "pending")))
    .returning({ id: attachments.id });
  return rows.length > 0;
}

/**
 * Drop a `pending` reservation after a failed upload (stream error, client
 * abort, storage failure). Best-effort: if the process dies before this
 * runs, the pending-TTL sweep reclaims the row instead.
 */
export async function deletePendingReservation(db: Database, id: string): Promise<void> {
  await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.state, "pending")));
}

export async function loadAttachmentMeta(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      objectKey: attachments.objectKey,
      state: attachments.state,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  return row ?? null;
}

export async function loadAttachmentData(db: Database, id: string): Promise<Buffer | null> {
  const [row] = await db.select({ data: attachments.data }).from(attachments).where(eq(attachments.id, id)).limit(1);
  return row?.data ?? null;
}

export type CreateLegacyAttachmentInput = {
  /** Optional caller-supplied id (UUIDv4). Generated when absent. */
  id?: string;
  mimeType: string;
  filename: string;
  data: Buffer;
  uploadedBy: string;
};

/**
 * Write a LEGACY-shaped row: payload inline in the `bytea` column, no
 * organization, no object key. The production upload path no longer does
 * this — it exists so migration tooling and tests can fabricate exactly the
 * pre-S3 rows the `migrate:attachments` command consumes.
 */
export async function createLegacyAttachment(
  db: Database,
  input: CreateLegacyAttachmentInput,
): Promise<AttachmentMeta> {
  if (input.data.byteLength === 0) {
    throw new BadRequestError("Attachment is empty");
  }
  if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(attachments)
    .values({
      id,
      organizationId: null,
      mimeType: input.mimeType,
      filename: input.filename,
      sizeBytes: input.data.byteLength,
      objectKey: null,
      state: "stored",
      data: input.data,
      uploadedBy: input.uploadedBy,
    })
    .returning({
      id: attachments.id,
      organizationId: attachments.organizationId,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      objectKey: attachments.objectKey,
      state: attachments.state,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
    });
  if (!row) {
    throw new Error("Attachment insert returned no row");
  }
  return row;
}
