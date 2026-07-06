import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { NotFoundError } from "../errors.js";
import type { DocCommentRow, DocDocumentRow } from "../services/document.js";
import { getCommentRow, getDocumentRow } from "../services/document.js";
import { requireUser } from "./require-user.js";
import type { OrgScope } from "./types.js";

/**
 * Class C access for the document review (docloop) surface: resolve the
 * resource by UUID, then the caller's active membership in the resource's
 * own org. Misses and non-members both read as 404 so existence does not
 * leak across orgs (same posture as `requireResourceAccess`).
 *
 * Documents have no per-doc ACL by design — any active member of the owning
 * org may read, comment, resolve, and change status.
 */
async function resolveCallerInOrg(db: Database, userId: string, orgId: string): Promise<OrgScope> {
  const [row] = await db
    .select({ id: members.id, role: members.role, agentId: members.agentId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId), eq(members.status, "active")))
    .limit(1);
  if (!row || (row.role !== "admin" && row.role !== "member")) {
    throw new NotFoundError("Document not found");
  }
  return { userId, organizationId: orgId, memberId: row.id, role: row.role, humanAgentId: row.agentId };
}

export async function requireDocumentAccess(
  request: FastifyRequest<{ Params: { docId: string } }>,
  db: Database,
): Promise<{ document: DocDocumentRow; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const document = await getDocumentRow(db, request.params.docId);
  if (!document) throw new NotFoundError("Document not found");
  const scope = await resolveCallerInOrg(db, userId, document.organizationId);
  return { document, scope };
}

export async function requireDocumentCommentAccess(
  request: FastifyRequest<{ Params: { commentId: string } }>,
  db: Database,
): Promise<{ comment: DocCommentRow; document: DocDocumentRow; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const comment = await getCommentRow(db, request.params.commentId);
  if (!comment) throw new NotFoundError("Comment not found");
  const document = await getDocumentRow(db, comment.documentId);
  if (!document) throw new NotFoundError("Comment not found");
  const scope = await resolveCallerInOrg(db, userId, document.organizationId);
  return { comment, document, scope };
}
