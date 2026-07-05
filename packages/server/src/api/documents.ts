import {
  createDocCommentRequestSchema,
  listDocCommentsQuerySchema,
  replyDocCommentRequestSchema,
  updateDocCommentRequestSchema,
  updateDocRequestSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireDocumentAccess, requireDocumentCommentAccess } from "../scope/require-document-access.js";
import { docAuthorForAgentUuid } from "../services/doc-author.js";
import {
  createComment,
  getDocumentWithVersion,
  listComments,
  setCommentStatus,
  setDocumentStatus,
} from "../services/document.js";

const getDocQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

/**
 * Document review (docloop) — resource surface (Class C).
 *
 *   GET   /api/v1/documents/:docId                 — read (latest or ?version=N)
 *   PATCH /api/v1/documents/:docId                 — change status
 *   GET   /api/v1/documents/:docId/comments        — list comments
 *   POST  /api/v1/documents/:docId/comments        — comment (anchored or doc-level)
 *
 * The document UUID locates its org; `requireDocumentAccess` resolves the
 * caller's membership there and 404s non-members so existence never leaks.
 */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { docId: string } }>("/:docId", async (request) => {
    const { document } = await requireDocumentAccess(request, app.db);
    const query = getDocQuerySchema.parse(request.query);
    return getDocumentWithVersion(app.db, document, query.version);
  });

  app.patch<{ Params: { docId: string } }>("/:docId", async (request) => {
    const { document } = await requireDocumentAccess(request, app.db);
    const payload = updateDocRequestSchema.parse(request.body);
    return setDocumentStatus(app.db, document, payload.status);
  });

  app.get<{ Params: { docId: string } }>("/:docId/comments", async (request) => {
    const { document } = await requireDocumentAccess(request, app.db);
    const query = listDocCommentsQuerySchema.parse(request.query);
    return { items: await listComments(app.db, document, query) };
  });

  app.post<{ Params: { docId: string } }>("/:docId/comments", async (request) => {
    const { document, scope } = await requireDocumentAccess(request, app.db);
    const payload = createDocCommentRequestSchema.parse(request.body);
    const author = await docAuthorForAgentUuid(app.db, scope.humanAgentId);
    return createComment(app.db, { ...payload, document, author });
  });
}

/**
 * Comment resource surface (Class C) — comment UUIDs are global, so replies
 * and status changes address the comment directly without the document id:
 *
 *   POST  /api/v1/document-comments/:commentId/replies  — reply in thread
 *   PATCH /api/v1/document-comments/:commentId          — resolve / reopen
 */
export async function documentCommentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { commentId: string } }>("/:commentId/replies", async (request) => {
    const { comment, document, scope } = await requireDocumentCommentAccess(request, app.db);
    const payload = replyDocCommentRequestSchema.parse(request.body);
    const author = await docAuthorForAgentUuid(app.db, scope.humanAgentId);
    return createComment(app.db, { body: payload.body, parentId: comment.id, document, author });
  });

  app.patch<{ Params: { commentId: string } }>("/:commentId", async (request) => {
    const { comment } = await requireDocumentCommentAccess(request, app.db);
    const payload = updateDocCommentRequestSchema.parse(request.body);
    return setCommentStatus(app.db, comment, payload.status);
  });
}
