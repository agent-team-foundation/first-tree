import {
  createDocCommentRequestSchema,
  listDocCommentsQuerySchema,
  listDocsQuerySchema,
  publishDocRequestSchema,
  replyDocCommentRequestSchema,
  updateDocCommentRequestSchema,
  updateDocRequestSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/connection.js";
import { NotFoundError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { docAuthorForAgentUuid } from "../../services/doc-author.js";
import type { DocCommentRow, DocDocumentRow } from "../../services/document.js";
import {
  createComment,
  getCommentRow,
  getDocumentRow,
  getDocumentWithVersion,
  listComments,
  listDocuments,
  publishDocument,
  setCommentStatus,
  setDocumentStatus,
} from "../../services/document.js";

const getDocQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

/**
 * Document review (docloop) — agent self surface (Class D, `/api/v1/agent`).
 *
 * The full publish/read/comment loop for the agent CLI (`first-tree doc …`):
 *
 *   POST  /agent/documents                          — publish (create or next version)
 *   GET   /agent/documents                          — list / filter (?slug= resolves a slug)
 *   GET   /agent/documents/:docId                   — read (latest or ?version=N)
 *   PATCH /agent/documents/:docId                   — change status
 *   GET   /agent/documents/:docId/comments          — list comments
 *   POST  /agent/documents/:docId/comments          — comment
 *   POST  /agent/document-comments/:commentId/replies — reply in thread
 *   PATCH /agent/document-comments/:commentId       — resolve / reopen
 *
 * Scope: the agent's own org (from the agent selector). Cross-org ids 404 so
 * existence never leaks. Authorship is the agent itself — a human member
 * driving the CLI comes through here as their identity-mirror agent and is
 * recorded with kind "human" (see services/doc-author.ts).
 */
export async function agentDocumentRoutes(app: FastifyInstance): Promise<void> {
  async function requireOrgDocument(db: Database, organizationId: string, docId: string): Promise<DocDocumentRow> {
    const document = await getDocumentRow(db, docId);
    if (!document || document.organizationId !== organizationId) {
      throw new NotFoundError("Document not found");
    }
    return document;
  }

  async function requireOrgComment(
    db: Database,
    organizationId: string,
    commentId: string,
  ): Promise<{ comment: DocCommentRow; document: DocDocumentRow }> {
    const comment = await getCommentRow(db, commentId);
    if (!comment) throw new NotFoundError("Comment not found");
    const document = await getDocumentRow(db, comment.documentId);
    if (!document || document.organizationId !== organizationId) {
      throw new NotFoundError("Comment not found");
    }
    return { comment, document };
  }

  app.post("/documents", async (request) => {
    const identity = requireAgent(request);
    const payload = publishDocRequestSchema.parse(request.body);
    const author = await docAuthorForAgentUuid(app.db, identity.uuid);
    return publishDocument(app.db, { ...payload, organizationId: identity.organizationId, author });
  });

  app.get("/documents", async (request) => {
    const identity = requireAgent(request);
    const query = listDocsQuerySchema.parse(request.query);
    return listDocuments(app.db, identity.organizationId, query);
  });

  app.get<{ Params: { docId: string } }>("/documents/:docId", async (request) => {
    const identity = requireAgent(request);
    const document = await requireOrgDocument(app.db, identity.organizationId, request.params.docId);
    const query = getDocQuerySchema.parse(request.query);
    return getDocumentWithVersion(app.db, document, query.version);
  });

  app.patch<{ Params: { docId: string } }>("/documents/:docId", async (request) => {
    const identity = requireAgent(request);
    const document = await requireOrgDocument(app.db, identity.organizationId, request.params.docId);
    const payload = updateDocRequestSchema.parse(request.body);
    return setDocumentStatus(app.db, document, payload.status);
  });

  app.get<{ Params: { docId: string } }>("/documents/:docId/comments", async (request) => {
    const identity = requireAgent(request);
    const document = await requireOrgDocument(app.db, identity.organizationId, request.params.docId);
    const query = listDocCommentsQuerySchema.parse(request.query);
    return { items: await listComments(app.db, document.id, query) };
  });

  app.post<{ Params: { docId: string } }>("/documents/:docId/comments", async (request) => {
    const identity = requireAgent(request);
    const document = await requireOrgDocument(app.db, identity.organizationId, request.params.docId);
    const payload = createDocCommentRequestSchema.parse(request.body);
    const author = await docAuthorForAgentUuid(app.db, identity.uuid);
    return createComment(app.db, { ...payload, document, author });
  });

  app.post<{ Params: { commentId: string } }>("/document-comments/:commentId/replies", async (request) => {
    const identity = requireAgent(request);
    const { comment, document } = await requireOrgComment(app.db, identity.organizationId, request.params.commentId);
    const payload = replyDocCommentRequestSchema.parse(request.body);
    const author = await docAuthorForAgentUuid(app.db, identity.uuid);
    return createComment(app.db, { body: payload.body, parentId: comment.id, document, author });
  });

  app.patch<{ Params: { commentId: string } }>("/document-comments/:commentId", async (request) => {
    const identity = requireAgent(request);
    const { comment } = await requireOrgComment(app.db, identity.organizationId, request.params.commentId);
    const payload = updateDocCommentRequestSchema.parse(request.body);
    return setCommentStatus(app.db, comment, payload.status);
  });
}
