import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  MAX_ATTACHMENT_BYTES,
  type UploadAttachmentResponse,
} from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { requireUser } from "../scope/require-user.js";
import {
  createAttachment,
  isCallerUploaderOrManager,
  loadAttachmentData,
  loadAttachmentMeta,
} from "../services/attachment.js";

/**
 * Object-storage primitive — first-tree's generic attachment surface.
 *
 *   POST /api/v1/attachments                        — upload bytes
 *   GET  /api/v1/attachments/:id[?chatId=...]       — download bytes
 *
 * Both require a valid user JWT (mounted under `userScope` in app.ts).
 * Upload protocol: `Content-Type: application/octet-stream` + the
 * `x-attachment-mime` / `x-attachment-filename` headers carry the logical
 * metadata. This keeps the body parser uniform and avoids pulling in a
 * multipart dependency.
 *
 * Download auth (short-circuit, in order):
 *   1. caller is the uploader or manages the agent that uploaded
 *   2. caller passed `?chatId=...` AND is a member of that chat
 *
 * The unguessable UUIDv4 id acts as a baseline against blind enumeration —
 * the `chatId` fallback exists so cross-member visibility (the only chat
 * primitive we expose today) Just Works without the upstream business
 * layer needing to mint per-recipient ACL rows.
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  // Single value for both client visibility (415 if wrong type) and route
  // bodyLimit. 16 KB headroom beyond MAX_ATTACHMENT_BYTES leaves space for
  // misc small request overhead without inflating the cap.
  const UPLOAD_BODY_LIMIT = MAX_ATTACHMENT_BYTES + 16 * 1024;

  app.post<{ Querystring: { orgId?: string } }>(
    "/",
    {
      bodyLimit: UPLOAD_BODY_LIMIT,
      config: { otelRecordBody: false },
    },
    async (request, reply) => {
      const { userId } = requireUser(request);
      const { orgId } = request.query;

      const contentType = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/octet-stream") {
        // Reject explicitly so callers can't smuggle a parsed body shape
        // and rely on the JSON parser eating the bytes.
        throw new BadRequestError(`Content-Type must be application/octet-stream (got "${contentType || "missing"}")`);
      }

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new BadRequestError("Request body must be raw bytes");
      }

      const mimeHeader = request.headers[ATTACHMENT_MIME_HEADER];
      const mimeType = (Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader)?.trim() ?? "";
      if (!mimeType) {
        throw new BadRequestError(`Missing ${ATTACHMENT_MIME_HEADER} header`);
      }

      const filenameHeader = request.headers[ATTACHMENT_FILENAME_HEADER];
      const filename = (Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader)?.trim() || "blob";

      // Resolve the caller's `agents.uuid` to use as `uploaded_by`. The JWT
      // carries only `userId`; for single-org users the unique active
      // membership is picked automatically. Multi-org users MUST pass
      // `?orgId=...` so the uploader identity is stable instead of
      // depending on PG row-order — without that hint the same caller's
      // uploads could land under different `humanAgentId`s across requests.
      const humanAgentId = await resolveUploaderHumanAgentId(app.db, userId, orgId);

      const row = await createAttachment(app.db, {
        mimeType,
        filename,
        data: body,
        uploadedBy: humanAgentId,
      });

      const response: UploadAttachmentResponse = {
        id: row.id,
        mimeType: row.mimeType,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        uploadedBy: row.uploadedBy,
        createdAt: row.createdAt.toISOString(),
      };
      return reply.status(201).send(response);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { chatId?: string } }>("/:id", async (request, reply) => {
    const { userId } = requireUser(request);
    const { id } = request.params;
    const { chatId } = request.query;

    // Load metadata only — auth + ETag run off this, so a 304 cache hit
    // never drags the bytea payload out of PG.
    const meta = await loadAttachmentMeta(app.db, id);
    if (!meta) {
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    const callerHumanAgentId = await resolveCallerHumanAgentId(app.db, userId);
    const uploaderRelation =
      callerHumanAgentId !== null &&
      (await isCallerUploaderOrManager(app.db, meta.uploadedBy, {
        userId,
        humanAgentId: callerHumanAgentId,
      }));

    if (!uploaderRelation) {
      if (!chatId) {
        throw new ForbiddenError("Attachment access requires uploader relation or ?chatId context");
      }
      await assertChatAccessByUserId(app.db, userId, chatId);
    }

    // If-None-Match: cheap ETag check. id is content-stable (UUIDv4 +
    // bytes are immutable once written), so we never need to vary on
    // anything else. Checked after auth so a 304 can't confirm existence
    // of an attachment the caller may not access.
    const ifNoneMatch = request.headers["if-none-match"];
    const etag = `"${meta.id}"`;
    if (ifNoneMatch === etag) {
      return reply.status(304).send();
    }

    const data = await loadAttachmentData(app.db, id);
    if (!data) {
      // Deleted between the metadata read and now — vanishingly rare, but
      // surface it honestly rather than streaming an empty body.
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    reply
      .header("Content-Type", meta.mimeType)
      .header("Content-Length", meta.sizeBytes)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", etag)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `inline; filename="${encodeRfc6266Filename(meta.filename)}"`);
    return reply.send(data);
  });
}

/**
 * For uploads — `uploaded_by` must be stable. Pick a deterministic
 * `humanAgentId` for the caller:
 *
 *  - With `?orgId=`: look up `members(userId, orgId, status='active')`. If
 *    the row is absent (caller not in that org, or member left), 403.
 *  - Without `?orgId=`: count active memberships. Exactly one → use it.
 *    Two or more → 400 telling the caller to supply `?orgId=...` so the
 *    uploaded_by isn't picked by PG row-order. Zero → 403.
 *
 * Throws `ForbiddenError` / `BadRequestError` with messages that surface
 * the actual fix the caller can apply.
 */
async function resolveUploaderHumanAgentId(db: Database, userId: string, orgId: string | undefined): Promise<string> {
  if (orgId !== undefined) {
    const [row] = await db
      .select({ agentId: members.agentId })
      .from(members)
      .where(and(eq(members.userId, userId), eq(members.organizationId, orgId), eq(members.status, "active")))
      .limit(1);
    if (!row) {
      throw new ForbiddenError(`Caller is not an active member of organization "${orgId}"`);
    }
    return row.agentId;
  }

  // Pull up to two rows — the second only exists to detect ambiguity, no
  // need for COUNT(*) when LIMIT 2 + .length carries the same signal.
  const rows = await db
    .select({ agentId: members.agentId, organizationId: members.organizationId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .limit(2);
  if (rows.length === 0) {
    throw new ForbiddenError("Caller is not a member of any organization");
  }
  if (rows.length > 1) {
    throw new BadRequestError(
      "Caller belongs to multiple organizations; specify ?orgId=... to pin the uploader identity",
    );
  }
  // length === 1 — safe to non-null assert because we just checked
  const only = rows[0];
  if (!only) throw new ForbiddenError("Caller is not a member of any organization");
  return only.agentId;
}

/**
 * For downloads — read-side resolution. Tolerant of multi-org callers
 * because the second auth layer (`isCallerUploaderOrManager` / chat
 * fallback) works off `userId`, not the picked humanAgentId. Returns
 * `null` when the user has no active membership at all.
 */
async function resolveCallerHumanAgentId(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .limit(1);
  return row?.agentId ?? null;
}

/**
 * Request-independent version of `requireChatAccess`. The standard helper
 * takes `chatId` from `request.params`, but here it comes from a query
 * parameter, so we replay the same join logic without round-tripping
 * through a forged request. Throws `ForbiddenError` instead of the
 * helper's `NotFoundError` because the attachment route should not lie
 * about chat existence — the caller already knows the chat id since they
 * supplied it.
 */
async function assertChatAccessByUserId(db: Database, userId: string, chatId: string): Promise<void> {
  const [chat] = await db
    .select({ id: chats.id, organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) {
    throw new ForbiddenError(`Attachment access denied: chat "${chatId}" not accessible`);
  }

  const [member] = await db
    .select({ memberId: members.id, agentId: members.agentId })
    .from(members)
    .where(
      and(eq(members.userId, userId), eq(members.organizationId, chat.organizationId), eq(members.status, "active")),
    )
    .limit(1);
  if (!member) {
    throw new ForbiddenError(`Attachment access denied: caller not in chat "${chatId}"`);
  }

  // Direct membership — caller's own human agent is a participant.
  const [direct] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, member.agentId)))
    .limit(1);
  if (direct) return;

  // Supervised access — any agent the caller manages speaks in this chat.
  const participantRows = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
  if (participantRows.length === 0) {
    throw new ForbiddenError(`Attachment access denied: chat "${chatId}" not accessible`);
  }
  const participantIds = participantRows.map((p) => p.agentId);
  const [managed] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(inArray(agents.uuid, participantIds), eq(agents.managerId, member.memberId)))
    .limit(1);
  if (!managed) {
    throw new ForbiddenError(`Attachment access denied: caller not in chat "${chatId}"`);
  }
}

/**
 * RFC 6266 percent-encoding for the `filename` directive — `inline; filename="..."`.
 * Only percent-encodes characters that would break the quoted-string parser
 * (CR/LF, quote, backslash). Browsers tolerate non-ASCII inside the quoted
 * form, but raw quotes / control chars would smuggle headers.
 */
function encodeRfc6266Filename(name: string): string {
  return name.replace(/[\r\n"\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
