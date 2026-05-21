import { createHash, randomUUID } from "node:crypto";
import {
  ATTACHMENT_LIMITS,
  type AttachmentRef,
  AttachmentRejectedError,
  classifyAttachment,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { messageAttachments } from "../db/schema/message-attachments.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { assertParticipant } from "./chat.js";

/** Subset of the drizzle client used here — satisfied by both `Database` and a tx. */
type AttachmentDb = Pick<PostgresJsDatabase<Record<string, never>>, "select" | "insert" | "update" | "delete">;

/** Unbound attachments left past this age are swept by the orphan GC. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

async function orgIdForChat(db: AttachmentDb, chatId: string): Promise<string> {
  const [row] = await db.select({ orgId: chats.organizationId }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!row) throw new NotFoundError("Chat not found");
  return row.orgId;
}

/**
 * Validate + persist one uploaded file (route 2 / PG-bytea). Runs the shared
 * type double-gate (size, extension deny list, magic-byte sniff, C1 magicless
 * safe-text allowance), computes sha256, derives kind, and enforces the org
 * storage quota before inserting. The row is created **unbound**
 * (`message_id = NULL`) and bound to a message at send time.
 *
 * The caller (route) must have already proven the uploader is a chat speaker.
 */
export async function createAttachment(
  db: AttachmentDb,
  args: { chatId: string; uploaderId: string; filename: string; declaredMime: string; bytes: Buffer },
): Promise<AttachmentRef> {
  let classification: { kind: "image" | "file"; mimeType: string };
  try {
    classification = classifyAttachment({
      filename: args.filename,
      declaredMime: args.declaredMime,
      head: args.bytes.subarray(0, 512),
      size: args.bytes.length,
    });
  } catch (err) {
    // Surface the shared validator's reason as a 400 (it is not an AppError).
    if (err instanceof AttachmentRejectedError) throw new BadRequestError(err.message);
    throw err;
  }

  const orgId = await orgIdForChat(db, args.chatId);
  const [usage] = await db
    .select({ total: sql<string>`coalesce(sum(${messageAttachments.size}), 0)` })
    .from(messageAttachments)
    .innerJoin(chats, eq(messageAttachments.chatId, chats.id))
    .where(eq(chats.organizationId, orgId));
  const used = Number(usage?.total ?? 0);
  if (used + args.bytes.length > ATTACHMENT_LIMITS.orgQuotaBytes) {
    throw new BadRequestError("Organization attachment storage quota exceeded.");
  }

  const id = randomUUID();
  const sha256 = createHash("sha256").update(args.bytes).digest("hex");
  await db.insert(messageAttachments).values({
    id,
    chatId: args.chatId,
    messageId: null,
    uploaderId: args.uploaderId,
    mime: classification.mimeType,
    filename: args.filename,
    size: args.bytes.length,
    sha256,
    kind: classification.kind,
    bytes: args.bytes,
  });

  return {
    attachmentId: id,
    mimeType: classification.mimeType,
    filename: args.filename,
    size: args.bytes.length,
    kind: classification.kind,
  };
}

/**
 * Validate the attachments a send references and return their authoritative
 * refs (mime/size/kind from the DB, never trusting client-sent values).
 * Enforces C3: each referenced attachment must be uploaded by the sender, still
 * unbound, and belong to this chat — blocking cross-user / replay references.
 * Also enforces the per-message count + total-size caps.
 *
 * Returns refs in the caller's requested order. Does NOT mutate — bind happens
 * in {@link bindAttachmentsToMessage} after the message row exists.
 */
export async function prepareAttachmentsForSend(
  tx: AttachmentDb,
  args: { chatId: string; senderId: string; attachmentIds: readonly string[] },
): Promise<AttachmentRef[]> {
  const ids = [...new Set(args.attachmentIds)];
  if (ids.length === 0) return [];
  if (ids.length > ATTACHMENT_LIMITS.maxMessageCount) {
    throw new BadRequestError(`Too many attachments (max ${ATTACHMENT_LIMITS.maxMessageCount} per message).`);
  }

  // `FOR UPDATE` locks the rows for this transaction so two concurrent sends
  // can't both pass the unbound check below: the second send blocks here until
  // the first commits, then sees `messageId !== null` and is rejected. Combined
  // with the row-count assertion in bindAttachmentsToMessage, a given upload can
  // bind to at most one message.
  const rows = await tx
    .select({
      id: messageAttachments.id,
      chatId: messageAttachments.chatId,
      messageId: messageAttachments.messageId,
      uploaderId: messageAttachments.uploaderId,
      mime: messageAttachments.mime,
      filename: messageAttachments.filename,
      size: messageAttachments.size,
      kind: messageAttachments.kind,
    })
    .from(messageAttachments)
    .where(inArray(messageAttachments.id, ids))
    .for("update");
  const byId = new Map(rows.map((r) => [r.id, r]));

  let totalBytes = 0;
  const refs: AttachmentRef[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new BadRequestError("Attachment not found or already expired.");
    if (row.uploaderId !== args.senderId) {
      // C3: never let a sender attach someone else's pending upload.
      throw new ForbiddenError("Cannot attach a file uploaded by someone else.");
    }
    if (row.messageId !== null) throw new BadRequestError("Attachment is already attached to a message.");
    if (row.chatId !== args.chatId) throw new BadRequestError("Attachment belongs to a different chat.");
    totalBytes += row.size;
    const kind = row.kind === "image" ? "image" : "file";
    refs.push({ attachmentId: row.id, mimeType: row.mime, filename: row.filename, size: row.size, kind });
  }
  if (totalBytes > ATTACHMENT_LIMITS.maxMessageBytes) {
    throw new BadRequestError(
      `Attachments exceed the per-message size limit (${ATTACHMENT_LIMITS.maxMessageBytes} bytes).`,
    );
  }
  return refs;
}

/**
 * Bind validated attachments to their message (sets `message_id`). The
 * `isNull(message_id)` guard + row-count assertion close the rebind race: if a
 * concurrent send bound any of these rows between validation and here, fewer
 * rows update than expected and we throw to roll back the whole send (so a
 * message is never persisted referencing an attachment bound elsewhere).
 */
export async function bindAttachmentsToMessage(
  tx: AttachmentDb,
  args: { messageId: string; attachmentIds: readonly string[] },
): Promise<void> {
  const ids = [...new Set(args.attachmentIds)];
  if (ids.length === 0) return;
  const bound = await tx
    .update(messageAttachments)
    .set({ messageId: args.messageId })
    .where(and(inArray(messageAttachments.id, ids), isNull(messageAttachments.messageId)))
    .returning({ id: messageAttachments.id });
  if (bound.length !== ids.length) {
    throw new ConflictError("An attachment was bound to another message concurrently — retry the send.");
  }
}

export type DownloadableAttachment = {
  bytes: Buffer;
  mime: string;
  filename: string;
  kind: string;
  size: number;
};

/**
 * Fetch an attachment's bytes for download, gated on the viewer being a current
 * speaker of the chat (membership re-checked on every request — leaving the
 * chat revokes access immediately). Bytes never leave the server except through
 * this authenticated route.
 */
export async function getAttachmentForDownload(
  db: Database,
  args: { chatId: string; attachmentId: string; viewerId: string },
): Promise<DownloadableAttachment> {
  await assertParticipant(db, args.chatId, args.viewerId);
  const [row] = await db
    .select({
      chatId: messageAttachments.chatId,
      messageId: messageAttachments.messageId,
      uploaderId: messageAttachments.uploaderId,
      bytes: messageAttachments.bytes,
      mime: messageAttachments.mime,
      filename: messageAttachments.filename,
      kind: messageAttachments.kind,
      size: messageAttachments.size,
    })
    .from(messageAttachments)
    .where(eq(messageAttachments.id, args.attachmentId))
    .limit(1);
  if (!row || row.chatId !== args.chatId) throw new NotFoundError("Attachment not found");
  // Still-unbound uploads are only readable by their uploader — they aren't part
  // of any message yet, so no other chat member should be able to pull them via
  // a guessed id (defence in depth on top of the random UUID).
  if (row.messageId === null && row.uploaderId !== args.viewerId) {
    throw new NotFoundError("Attachment not found");
  }
  return { bytes: row.bytes, mime: row.mime, filename: row.filename, kind: row.kind, size: row.size };
}

/**
 * Delete attachments that were uploaded but never bound to a message within the
 * TTL (e.g. the user attached a file then abandoned the compose). Returns the
 * number deleted. Intended to run on a periodic sweep.
 */
export async function gcOrphanedAttachments(db: AttachmentDb): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_TTL_MS);
  const deleted = await db
    .delete(messageAttachments)
    .where(and(isNull(messageAttachments.messageId), lt(messageAttachments.createdAt, cutoff)))
    .returning({ id: messageAttachments.id });
  return deleted.length;
}
