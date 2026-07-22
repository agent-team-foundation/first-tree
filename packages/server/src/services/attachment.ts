import { randomUUID } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import {
  ATTACHMENT_ORPHAN_GRACE_MS,
  ATTACHMENT_QUOTA_EXCEEDED,
  ATTACHMENT_STORAGE_NOT_CONFIGURED,
  ATTACHMENT_UPLOAD_CONCURRENCY_EXCEEDED,
  ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_GLOBAL,
  ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER,
  isImageBatchRefContent,
  isImageRefContent,
  MAX_ATTACHMENT_BYTES,
  ORG_ATTACHMENT_MAX_BYTES,
  ORG_ATTACHMENT_MAX_COUNT,
} from "@first-tree/shared";
import { eq, lt, Param, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import {
  type AppErrorAttrs,
  BadRequestError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnprocessableError,
} from "../errors.js";
import { createLogger } from "../observability/index.js";
import type { AttachmentStore } from "./attachment-store.js";

const log = createLogger("attachment");

/**
 * Attachment service — object-storage primitive over S3 with a legacy bytea
 * fallback for pre-migration rows.
 *
 * - `createAttachmentFromStream` is the upload path: streams request bytes
 *   straight to S3 behind a counting stream (single-file cap → 413), a
 *   two-level in-flight concurrency guard (→ 429), and org quota accounting
 *   serialized by an `organizations` row lock (→ 422).
 * - `loadAttachmentMeta` looks up by id WITHOUT the bytea payload; returns
 *   `null` on miss so the route layer can emit a 404 cleanly. The download
 *   route runs the ETag check off the metadata so a cache hit (304) never
 *   touches S3 or the blob.
 * - `loadAttachmentData` fetches the legacy `bytea` payload, called only
 *   when the row has no `object_key` (pre-migration dual-track window).
 * - `createAttachment` is the legacy bytea insert, kept for the dual-track
 *   window and tests; new production uploads always go through the stream
 *   path above.
 * - Reference lifecycle: `collectReferencedAttachmentIds` answers "is this
 *   id still referenced anywhere" in one round trip (reference-point
 *   registry below); `deleteAttachment` is the single delete primitive
 *   (idempotent S3 delete + row delete) used by the orphan sweeper, the
 *   message-edit hook, and upload-failure compensation.
 *
 * Download authorization is a capability model handled at the route layer:
 * a valid user JWT plus knowledge of the unguessable id. The service holds no
 * ACL logic.
 */

export class AttachmentQuotaExceededError extends UnprocessableError {
  readonly code = ATTACHMENT_QUOTA_EXCEEDED;
  constructor(message: string, attrs?: AppErrorAttrs) {
    super(message, attrs);
    this.name = "AttachmentQuotaExceededError";
  }
}

export class AttachmentUploadConcurrencyError extends TooManyRequestsError {
  readonly code = ATTACHMENT_UPLOAD_CONCURRENCY_EXCEEDED;
  constructor(message: string, attrs?: AppErrorAttrs) {
    super(message, attrs);
    this.name = "AttachmentUploadConcurrencyError";
  }
}

export class AttachmentStorageNotConfiguredError extends ServiceUnavailableError {
  readonly code = ATTACHMENT_STORAGE_NOT_CONFIGURED;
  constructor(
    message = "Attachment storage is not configured on this server (FIRST_TREE_S3_* unset)",
    attrs?: AppErrorAttrs,
  ) {
    super(message, attrs);
    this.name = "AttachmentStorageNotConfiguredError";
  }
}

export type AttachmentRow = typeof attachments.$inferSelect;

/** Everything in `AttachmentRow` except the legacy `bytea` payload. */
export type AttachmentMeta = Omit<AttachmentRow, "data">;

/** A select-capable executor — `Database` or a transaction both satisfy it, so
 *  read helpers can run inside a caller's open transaction. */
export type AttachmentReader = Pick<Database, "select">;

const ATTACHMENT_META_COLUMNS = {
  id: attachments.id,
  mimeType: attachments.mimeType,
  filename: attachments.filename,
  sizeBytes: attachments.sizeBytes,
  orgId: attachments.orgId,
  objectKey: attachments.objectKey,
  uploadedBy: attachments.uploadedBy,
  createdAt: attachments.createdAt,
} as const;

export async function loadAttachmentMeta(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db.select(ATTACHMENT_META_COLUMNS).from(attachments).where(eq(attachments.id, id)).limit(1);
  return row ?? null;
}

export async function loadAttachmentData(db: Database, id: string): Promise<Buffer | null> {
  const [row] = await db.select({ data: attachments.data }).from(attachments).where(eq(attachments.id, id)).limit(1);
  return row?.data ?? null;
}

// ── Legacy bytea insert (dual-track window + tests) ─────────────────────────

export type CreateAttachmentInput = {
  /** Optional caller-supplied id (UUIDv4). Generated when absent. */
  id?: string;
  mimeType: string;
  filename: string;
  data: Buffer;
  /** `agents.uuid` of the uploader; humans pass their humanAgentId. */
  uploadedBy: string;
};

/**
 * Legacy bytea insert. New uploads use {@link createAttachmentFromStream};
 * this remains for seeding pre-migration rows (tests) and any in-window
 * writer that still holds bytes in memory. No quota accounting — the S3
 * path owns governance.
 */
export async function createAttachment(db: Database, input: CreateAttachmentInput): Promise<AttachmentRow> {
  if (input.data.byteLength === 0) {
    throw new BadRequestError("Attachment is empty");
  }
  if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  assertMimeAndFilename(input.mimeType, input.filename);

  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(attachments)
    .values({
      id,
      mimeType: input.mimeType,
      filename: input.filename,
      sizeBytes: input.data.byteLength,
      data: input.data,
      uploadedBy: input.uploadedBy,
    })
    .returning();
  if (!row) {
    // Drizzle returns the inserted row(s); empty array would only happen on
    // a driver bug. Throw rather than swallow — caller would see a wrong-
    // shape return otherwise.
    throw new Error("Attachment insert returned no row");
  }
  return row;
}

function assertMimeAndFilename(mimeType: string, filename: string): void {
  if (mimeType.trim().length === 0) {
    throw new BadRequestError("Attachment mime type is required");
  }
  if (filename.trim().length === 0) {
    throw new BadRequestError("Attachment filename is required");
  }
}

// ── Upload concurrency guard (per-process, two levels) ──────────────────────

let globalInFlightUploads = 0;
const perUploaderInFlightUploads = new Map<string, number>();

/**
 * Acquire an in-flight upload slot. Per-process semantics: bounds the heap
 * committed to streaming uploads on THIS replica (`@aws-sdk/lib-storage`
 * buffers ~20 MiB per stream), not the fleet. Throws 429 when either the
 * per-uploader or the process-global cap is reached. The returned release
 * function is idempotent and must run in a `finally`.
 */
export function acquireAttachmentUploadSlot(uploadedBy: string): () => void {
  const perUploader = perUploaderInFlightUploads.get(uploadedBy) ?? 0;
  if (globalInFlightUploads >= ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_GLOBAL) {
    throw new AttachmentUploadConcurrencyError(
      `Too many in-flight attachment uploads on this server (global cap ${ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_GLOBAL})`,
      { "attachment_upload.in_flight_global": globalInFlightUploads },
    );
  }
  if (perUploader >= ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER) {
    throw new AttachmentUploadConcurrencyError(
      `Too many in-flight attachment uploads for this uploader (cap ${ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER})`,
      { "attachment_upload.in_flight_per_uploader": perUploader },
    );
  }
  globalInFlightUploads += 1;
  perUploaderInFlightUploads.set(uploadedBy, perUploader + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalInFlightUploads -= 1;
    const remaining = (perUploaderInFlightUploads.get(uploadedBy) ?? 1) - 1;
    if (remaining <= 0) {
      perUploaderInFlightUploads.delete(uploadedBy);
    } else {
      perUploaderInFlightUploads.set(uploadedBy, remaining);
    }
  };
}

// ── Streaming upload ────────────────────────────────────────────────────────

export type CreateAttachmentFromStreamInput = {
  /** Optional caller-supplied id (UUIDv4). Generated when absent. */
  id?: string;
  mimeType: string;
  filename: string;
  /** Raw request body stream (scoped octet-stream parser passes it through). */
  stream: Readable;
  /** `agents.uuid` of the uploader; humans pass their humanAgentId. */
  uploadedBy: string;
  /** Owning organization — the upload route's `:orgId`, stored on the row. */
  orgId: string;
};

export async function createAttachmentFromStream(
  db: Database,
  store: AttachmentStore | null,
  input: CreateAttachmentFromStreamInput,
): Promise<AttachmentMeta> {
  assertMimeAndFilename(input.mimeType, input.filename);
  if (!store) {
    throw new AttachmentStorageNotConfiguredError();
  }

  // Concurrency guard FIRST: it is the cheapest rejection and bounds how
  // many streams this process buffers at once.
  const releaseSlot = acquireAttachmentUploadSlot(input.uploadedBy);
  try {
    // Quota fast path: reject orgs already at/over the line before spending
    // bandwidth on the stream. Not the TOCTOU barrier — the authoritative
    // check re-runs under the org row lock right before the insert below.
    const preUsage = await readOrgAttachmentUsage(db, input.orgId);
    if (preUsage.count >= ORG_ATTACHMENT_MAX_COUNT || preUsage.bytes >= ORG_ATTACHMENT_MAX_BYTES) {
      throw orgQuotaError(preUsage);
    }

    const id = input.id ?? randomUUID();
    const objectKey = `attachments/${input.orgId}/${id}`;

    // Stream to S3 behind a counting Transform. The byte cap lives HERE —
    // Fastify's route `bodyLimit` only fires for buffering parsers, not for
    // the stream pass-through the route registers. Over the cap we abort
    // the multipart upload and map the rejection to 413.
    const abort = new AbortController();
    let bytesReceived = 0;
    let oversize = false;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesReceived += chunk.byteLength;
        if (!oversize && bytesReceived > MAX_ATTACHMENT_BYTES) {
          oversize = true;
          abort.abort();
        }
        callback(null, chunk);
      },
    });
    input.stream.pipe(counting);
    // pipe() does not forward errors: without this a client disconnect
    // mid-body leaves the multipart consumer waiting forever.
    input.stream.once("error", (err) => counting.destroy(err));

    try {
      await store.upload(objectKey, counting, input.mimeType, abort.signal);
    } catch (err) {
      if (oversize) {
        throw new PayloadTooLargeError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
      }
      throw err;
    }
    if (oversize) {
      // Defensive: the abort should always reject the upload above, but a
      // raced completion must not write a row for over-cap bytes.
      throw new PayloadTooLargeError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
    }

    if (bytesReceived === 0) {
      // lib-storage completes an empty stream as a 0-byte object; remove it
      // (idempotent) so the rejected upload leaves nothing behind.
      await store.deleteObject(objectKey).catch((err) => {
        log.warn({ err, objectKey }, "failed to remove empty object after rejecting empty upload");
      });
      throw new BadRequestError("Attachment is empty");
    }

    // Authoritative quota accounting + insert in one transaction. The org
    // row lock serializes same-org concurrent uploads so the usage read
    // cannot go stale between check and insert (TOCTOU); the lock is held
    // for milliseconds, never across the stream.
    try {
      return await db.transaction(async (tx) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, input.orgId))
          .for("update");
        const usage = await readOrgAttachmentUsage(tx, input.orgId);
        if (usage.count + 1 > ORG_ATTACHMENT_MAX_COUNT || usage.bytes + bytesReceived > ORG_ATTACHMENT_MAX_BYTES) {
          throw orgQuotaError(usage);
        }
        const [row] = await tx
          .insert(attachments)
          .values({
            id,
            mimeType: input.mimeType,
            filename: input.filename,
            sizeBytes: bytesReceived,
            orgId: input.orgId,
            objectKey,
            uploadedBy: input.uploadedBy,
          })
          .returning(ATTACHMENT_META_COLUMNS);
        if (!row) {
          throw new Error("Attachment insert returned no row");
        }
        return row;
      });
    } catch (err) {
      // The S3 object is already stored but the row is not — compensate
      // best-effort (idempotent delete) so a failed insert does not leak an
      // unaccounted object. The row-less object is otherwise invisible.
      await store.deleteObject(objectKey).catch((cleanupErr) => {
        log.warn({ err: cleanupErr, objectKey }, "failed to compensate S3 object after attachment insert failure");
      });
      throw err;
    }
  } finally {
    releaseSlot();
  }
}

type OrgAttachmentUsage = { count: number; bytes: number };

async function readOrgAttachmentUsage(db: AttachmentReader, orgId: string): Promise<OrgAttachmentUsage> {
  const [row] = await db
    .select({
      // ::bigint can come back as a string depending on the driver; Number()
      // normalizes. Realistic sums (≤1000 rows × 10 MiB) stay far below 2^53.
      count: sql<number | string>`count(*)::bigint`,
      bytes: sql<number | string>`coalesce(sum(${attachments.sizeBytes}), 0)::bigint`,
    })
    .from(attachments)
    .where(eq(attachments.orgId, orgId));
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

function orgQuotaError(usage: OrgAttachmentUsage): AttachmentQuotaExceededError {
  if (usage.count >= ORG_ATTACHMENT_MAX_COUNT) {
    return new AttachmentQuotaExceededError(
      `Organization attachment count quota exceeded (max ${ORG_ATTACHMENT_MAX_COUNT})`,
      { "attachment_quota.count": usage.count },
    );
  }
  return new AttachmentQuotaExceededError(
    `Organization attachment storage quota exceeded (max ${ORG_ATTACHMENT_MAX_BYTES} bytes)`,
    { "attachment_quota.bytes": usage.bytes },
  );
}

// ── Reference-point registry ────────────────────────────────────────────────

/**
 * Every place an attachment id can be referenced from, one entry per
 * reference shape. Each entry contributes one UNION arm selecting matching
 * ids as a single `ref_id` text column, and
 * {@link collectReferencedAttachmentIds} unions all arms into ONE round
 * trip (the sweeper pays at most one `messages` sequential scan per tick,
 * not one point query per candidate). New reference points (e.g. a future
 * avatar migration) register another arm here — no other sweep code
 * changes. Deliberately no GIN index over `messages.content`: write
 * amplification is not worth it for one bounded (≤200 ids), low-frequency
 * scan.
 */
type AttachmentReferencePoint = {
  /** Stable name, for logs and tests. */
  readonly name: string;
  /** SQL arm selecting the referenced ids (alias `ref_id`) within the candidate set. */
  readonly referencedIdsArm: (candidateIds: string[]) => SQL;
};

/**
 * Wrap the candidate list as ONE bound parameter. A bare array interpolated
 * into a drizzle `sql` template is expanded into a `($1, $2, …)` record
 * (built for `IN` lists), which Postgres then refuses to cast to `text[]`;
 * `Param` passes it whole so postgres-js serializes it as a real array.
 */
function idArrayParam(candidateIds: string[]): Param {
  return new Param(candidateIds);
}

const ATTACHMENT_REFERENCE_POINTS: AttachmentReferencePoint[] = [
  {
    // Single-image message: messages.content = { imageId, mimeType, filename }
    // with format='file'. Shape contract: shared/schemas/image-payload.ts
    // (imageRefContentSchema).
    name: "messages.content.imageId",
    referencedIdsArm: (candidateIds) => sql`
      SELECT content ->> 'imageId' AS ref_id
      FROM ${messages}
      WHERE content ->> 'imageId' = ANY(${idArrayParam(candidateIds)}::text[])
    `,
  },
  {
    // Batched-image message: messages.content.attachments[] each carry an
    // imageId. Shape contract: shared/schemas/image-payload.ts
    // (imageBatchRefContentSchema).
    name: "messages.content.attachments[].imageId",
    referencedIdsArm: (candidateIds) => sql`
      SELECT ref.value ->> 'imageId' AS ref_id
      FROM ${messages}, jsonb_array_elements(content -> 'attachments') AS ref(value)
      WHERE jsonb_typeof(content -> 'attachments') = 'array'
        AND ref.value ->> 'imageId' = ANY(${idArrayParam(candidateIds)}::text[])
    `,
  },
  {
    // Generic attachment refs: messages.metadata.attachments[].attachmentId.
    // Shape contract: shared/schemas/attachment-ref.ts (attachmentRefSchema).
    name: "messages.metadata.attachments[].attachmentId",
    referencedIdsArm: (candidateIds) => sql`
      SELECT ref.value ->> 'attachmentId' AS ref_id
      FROM ${messages}, jsonb_array_elements(metadata -> 'attachments') AS ref(value)
      WHERE jsonb_typeof(metadata -> 'attachments') = 'array'
        AND ref.value ->> 'attachmentId' = ANY(${idArrayParam(candidateIds)}::text[])
    `,
  },
];

/** Names of the registered reference points — exported for tests. */
export const ATTACHMENT_REFERENCE_POINT_NAMES = ATTACHMENT_REFERENCE_POINTS.map((point) => point.name);

/**
 * Which of `candidateIds` are still referenced by at least one registered
 * reference point. One round trip regardless of candidate count.
 */
export async function collectReferencedAttachmentIds(
  db: Pick<Database, "execute">,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const union = sql.join(
    ATTACHMENT_REFERENCE_POINTS.map((point) => point.referencedIdsArm(candidateIds)),
    sql` UNION `,
  );
  const rows = await db.execute<{ ref_id: string | null }>(
    sql`SELECT DISTINCT ref_id FROM (${union}) AS refs WHERE ref_id IS NOT NULL`,
  );
  const referenced = new Set<string>();
  for (const row of rows) {
    if (typeof row.ref_id === "string") referenced.add(row.ref_id);
  }
  return referenced;
}

/**
 * Extract the attachment ids a message content payload references. Only
 * `content` carries ids on the edit path (metadata.attachments is never
 * rewritten by an edit). Uses the shared shape guards so extraction matches
 * the send-path contract exactly.
 */
export function attachmentIdsFromMessageContent(content: unknown): string[] {
  if (isImageRefContent(content)) return [content.imageId];
  if (isImageBatchRefContent(content)) return content.attachments.map((ref) => ref.imageId);
  return [];
}

// ── Delete primitive + reference lifecycle ──────────────────────────────────

/**
 * The single attachment delete primitive. Idempotent end to end: the S3
 * delete treats NoSuchKey as success, so a caller retrying after a crash
 * between object-delete and row-delete converges. Legacy bytea rows (no
 * `object_key`) skip S3 entirely. Returns false when the row is already
 * gone.
 *
 * Throws `AttachmentStorageNotConfiguredError` when the row is S3-backed
 * but this server has no store configured — deleting only the row would
 * leak the object, so we fail fast instead.
 */
export async function deleteAttachment(db: Database, store: AttachmentStore | null, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: attachments.id, objectKey: attachments.objectKey })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  if (!row) return false;
  if (row.objectKey) {
    if (!store) {
      throw new AttachmentStorageNotConfiguredError();
    }
    await store.deleteObject(row.objectKey);
  }
  await db.delete(attachments).where(eq(attachments.id, id));
  return true;
}

/**
 * Delete every id in `candidateIds` that no registered reference point uses
 * anymore. Per-id failures are logged and skipped (the row stays and the
 * orphan sweep retries) — this is a best-effort fast path, never a
 * correctness gate for the caller.
 */
export async function deleteUnreferencedAttachments(
  db: Database,
  store: AttachmentStore | null,
  candidateIds: string[],
): Promise<void> {
  if (candidateIds.length === 0) return;
  const referenced = await collectReferencedAttachmentIds(db, candidateIds);
  for (const id of candidateIds) {
    if (referenced.has(id)) continue;
    try {
      await deleteAttachment(db, store, id);
    } catch (err) {
      log.warn({ err, attachmentId: id }, "unreferenced attachment delete failed; orphan sweep will retry");
    }
  }
}

// ── Orphan sweep ────────────────────────────────────────────────────────────

/** Max candidates examined per sweep tick. Bounds the reference scan cost. */
export const ATTACHMENT_ORPHAN_SWEEP_BATCH_SIZE = 200;

/**
 * Sweep candidates: attachments older than the 24h orphan grace. The grace
 * makes the "uploaded but the referencing message hasn't landed yet" window
 * practically un-hittable; the sweeper never sees fresh rows.
 */
export async function findOrphanSweepCandidates(
  db: AttachmentReader,
  now: Date = new Date(),
): Promise<AttachmentMeta[]> {
  const cutoff = new Date(now.getTime() - ATTACHMENT_ORPHAN_GRACE_MS);
  return db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .where(lt(attachments.createdAt, cutoff))
    .orderBy(attachments.createdAt)
    .limit(ATTACHMENT_ORPHAN_SWEEP_BATCH_SIZE);
}

export type OrphanSweepStats = {
  scanned: number;
  deleted: number;
  failed: number;
};

/**
 * One orphan-sweep round: candidates past the grace period with zero
 * references get their S3 object (idempotent) and row deleted. Rows whose
 * delete fails stay for the next round.
 */
export async function sweepOrphanAttachments(
  db: Database,
  store: AttachmentStore | null,
  opts: { now?: Date } = {},
): Promise<OrphanSweepStats> {
  const candidates = await findOrphanSweepCandidates(db, opts.now);
  if (candidates.length === 0) return { scanned: 0, deleted: 0, failed: 0 };

  const referenced = await collectReferencedAttachmentIds(
    db,
    candidates.map((candidate) => candidate.id),
  );

  let deleted = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (referenced.has(candidate.id)) continue;
    try {
      await deleteAttachment(db, store, candidate.id);
      deleted += 1;
    } catch (err) {
      failed += 1;
      log.warn({ err, attachmentId: candidate.id }, "orphan sweep delete failed; row kept for next round");
    }
  }
  return { scanned: candidates.length, deleted, failed };
}
