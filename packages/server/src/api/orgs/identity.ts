import { updateOrganizationSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import { forceDisconnect } from "../../services/connection-manager.js";
import * as orgService from "../../services/organization.js";
import * as presenceService from "../../services/presence.js";

/**
 * Class B — `/api/v1/orgs/:orgId` itself: read & rename the org row.
 * Replaces the deleted `/admin/organizations/:id` GET/PATCH pair.
 */
export async function orgIdentityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const org = await orgService.getOrganization(app.db, scope.organizationId);
    return {
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    };
  });

  app.patch<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const body = updateOrganizationSchema.parse(request.body);
    const org = await orgService.updateOrganization(app.db, scope.organizationId, body);
    return {
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    };
  });

  app.get<{ Params: { orgId: string } }>("/delete-preview", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    return orgService.previewOrganizationDeletion(app.db, scope.organizationId);
  });

  app.delete<{ Params: { orgId: string } }>("/", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const { impact, deletedAgentIds } = await orgService.deleteOrganization(app.db, scope.organizationId);
    for (const agentId of deletedAgentIds) {
      forceDisconnect(agentId, "organization_deleted");
      await presenceService.unbindAgent(app.db, agentId);
    }
    return reply.send(impact);
  });
}
