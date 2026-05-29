import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { members } from "../db/schema/members.js";
import { BadRequestError } from "../errors.js";

/**
 * Object-storage primitive (M1).
 *
 * - `createAttachment` writes a row, returns the inserted record.
 * - `loadAttachmentMeta` looks up by id WITHOUT the `bytea` payload; returns
 *   `null` on miss so the route layer can emit a 404 cleanly. The download
 *   route runs auth + ETag off the metadata so a cache hit (304) never pulls
 *   the blob out of PG.
 * - `loadAttachmentData` fetches just the `bytea` payload, called only once
 *   the route has decided to actually stream bytes.
 * - `isCallerUploaderOrManager` is the first auth gate for downloads. The
 *   second gate (`?chatId=...` -> chat membership) lives in the route
 *   layer where `requireChatAccess` already knows how to throw a clean
 *   404 / 403 split.
 *
 * Service throws `BadRequestError` for input validation (oversize / empty
 * bytes / blank mime). Route layer maps service exceptions to HTTP.
 */

export type AttachmentRow = typeof attachments.$inferSelect;

export type CreateAttachmentInput = {
  /** Optional caller-supplied id (UUIDv4). Generated when absent. */
  id?: string;
  mimeType: string;
  filename: string;
  data: Buffer;
  /** `agents.uuid` of the uploader; humans pass their humanAgentId. */
  uploadedBy: string;
};

export async function createAttachment(db: Database, input: CreateAttachmentInput): Promise<AttachmentRow> {
  if (input.data.byteLength === 0) {
    throw new BadRequestError("Attachment is empty");
  }
  if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  if (input.mimeType.trim().length === 0) {
    throw new BadRequestError("Attachment mime type is required");
  }
  if (input.filename.trim().length === 0) {
    throw new BadRequestError("Attachment filename is required");
  }

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

/** Everything in `AttachmentRow` except the `bytea` payload. */
export type AttachmentMeta = Omit<AttachmentRow, "data">;

export async function loadAttachmentMeta(db: Database, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
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

/**
 * Returns true when the caller either uploaded the attachment themselves or
 * is the user who manages the agent that did. The route layer should call
 * this first; on `false` it falls through to the `?chatId` membership check.
 *
 * Implementation: a single `agents -> members` join keyed on
 * `agents.uuid = uploadedBy` resolves the uploader's owning user id. For a
 * direct match (`caller.humanAgentId === uploadedBy`) we skip the query.
 */
export async function isCallerUploaderOrManager(
  db: Database,
  uploadedBy: string,
  caller: { userId: string; humanAgentId: string },
): Promise<boolean> {
  if (caller.humanAgentId === uploadedBy) return true;

  const [row] = await db
    .select({ ownerUserId: members.userId })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .where(eq(agents.uuid, uploadedBy))
    .limit(1);

  return row?.ownerUserId === caller.userId;
}
