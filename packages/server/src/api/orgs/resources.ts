import { createTeamResourceSchema, resourceImpactPreviewSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";

export async function orgResourceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    return app.resourcesService.listTeamResources(scope.organizationId);
  });

  app.post<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    if (scope.role !== "admin") throw new ForbiddenError("Admin role required");
    const body = createTeamResourceSchema.parse(request.body);
    const row = await app.resourcesService.createTeamResource(scope.organizationId, body, scope.memberId);
    return reply.status(201).send(row);
  });

  app.post<{ Params: { orgId: string } }>("/impact-preview", { config: { otelRecordBody: true } }, async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    if (scope.role !== "admin") throw new ForbiddenError("Admin role required");
    const body = resourceImpactPreviewSchema.parse(request.body);
    return app.resourcesService.previewOrgImpact(scope.organizationId, body);
  });
}
