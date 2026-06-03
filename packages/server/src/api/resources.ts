import { resourceImpactPreviewSchema, updateTeamResourceSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireResourceAccess } from "../scope/require-resource-access.js";

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { resourceId: string } }>("/:resourceId", async (request) => {
    await requireResourceAccess(request, app.db, "read");
    return app.resourcesService.getResource(request.params.resourceId);
  });

  app.patch<{ Params: { resourceId: string } }>(
    "/:resourceId",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { scope } = await requireResourceAccess(request, app.db, "write");
      const body = updateTeamResourceSchema.parse(request.body);
      return app.resourcesService.updateResource(request.params.resourceId, body, scope.memberId);
    },
  );

  app.delete<{ Params: { resourceId: string } }>("/:resourceId", async (request) => {
    const { scope } = await requireResourceAccess(request, app.db, "write");
    return app.resourcesService.retireResource(request.params.resourceId, scope.memberId);
  });

  app.post<{ Params: { resourceId: string } }>("/:resourceId/promote", async (request) => {
    const { scope } = await requireResourceAccess(request, app.db, "write");
    return app.resourcesService.promoteResource(request.params.resourceId, scope.memberId);
  });

  app.get<{ Params: { resourceId: string } }>("/:resourceId/usage", async (request) => {
    await requireResourceAccess(request, app.db, "read");
    return app.resourcesService.getUsage(request.params.resourceId);
  });

  app.post<{ Params: { resourceId: string } }>(
    "/:resourceId/impact-preview",
    { config: { otelRecordBody: true } },
    async (request) => {
      await requireResourceAccess(request, app.db, "write");
      resourceImpactPreviewSchema.parse(request.body);
      return app.resourcesService.previewResourceImpact(request.params.resourceId, {});
    },
  );
}
