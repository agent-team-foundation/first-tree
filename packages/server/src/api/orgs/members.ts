import { createMemberSchema, updateMemberSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import * as memberService from "../../services/member.js";

/** Class B — `/api/v1/orgs/:orgId/members`. */
export async function orgMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    return memberService.listMembers(app.db, scope.organizationId);
  });

  app.post<{ Params: { orgId: string } }>("/", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const body = createMemberSchema.parse(request.body);
    const result = await memberService.createMember(app.db, scope.organizationId, body);
    return reply.status(201).send(result);
  });

  app.patch<{ Params: { orgId: string; id: string } }>("/:id", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const body = updateMemberSchema.parse(request.body);
    return memberService.updateMember(app.db, request.params.id, body, scope.organizationId);
  });

  app.delete<{ Params: { orgId: string; id: string } }>("/:id", async (request, reply) => {
    await requireOrgAdmin(request, app.db);
    await memberService.deleteMember(app.db, request.params.id);
    return reply.status(204).send();
  });
}
