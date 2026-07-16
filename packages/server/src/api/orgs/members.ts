import { createMemberSchema, updateMemberSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import {
  assertMemberIsNotLandingCampaignServiceMember,
  isLandingCampaignServiceMembership,
} from "../../services/landing-campaigns/guards.js";
import * as memberService from "../../services/member.js";

/** Class B — `/api/v1/orgs/:orgId/members`. */
export async function orgMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const rows = await memberService.listMembers(app.db, scope.organizationId);
    return rows.filter((row) => !isLandingCampaignServiceMembership(app.config, row));
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
    await assertMemberIsNotLandingCampaignServiceMember(app.db, app.config, request.params.id, scope.organizationId);
    return memberService.updateMember(app.db, request.params.id, body, scope.organizationId);
  });

  app.delete<{ Params: { orgId: string; id: string } }>("/:id", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    await assertMemberIsNotLandingCampaignServiceMember(app.db, app.config, request.params.id, scope.organizationId);
    await memberService.deleteMember(app.db, request.params.id, scope.organizationId, scope.memberId);
    return reply.status(204).send();
  });
}
