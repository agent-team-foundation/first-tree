import { listDocsQuerySchema, publishDocRequestSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import { docAuthorForAgentUuid } from "../../services/doc-author.js";
import { listDocuments, publishDocument } from "../../services/document.js";

/**
 * Document review (docloop) — org surface (Class B).
 *
 *   GET  /api/v1/orgs/:orgId/documents   — list / filter the org's library
 *   POST /api/v1/orgs/:orgId/documents   — publish (create or next version)
 *
 * Publishing is idempotent on `slug`: the first publish creates the document
 * with version 1, every later publish of the same slug appends the next
 * version. Human callers author as their identity-mirror agent; the agent
 * surface for the same operations lives under `/api/v1/agent/documents`
 * (api/agent/documents.ts).
 */
export async function orgDocumentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = listDocsQuerySchema.parse(request.query);
    return listDocuments(app.db, scope.organizationId, query);
  });

  app.post<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const payload = publishDocRequestSchema.parse(request.body);
    const author = await docAuthorForAgentUuid(app.db, scope.humanAgentId);
    return publishDocument(app.db, { ...payload, organizationId: scope.organizationId, author });
  });
}
