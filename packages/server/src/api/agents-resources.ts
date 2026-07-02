import { updateAgentResourcesSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import { assertMutableAgentIsNotLandingCampaignTrial } from "../services/landing-campaigns/guards.js";

export async function agentResourcesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/resources", async (request) => {
    await requireAgentAccess(request, app.db, "visible");
    return app.resourcesService.getAgentResources(request.params.uuid);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/resources", { config: { otelRecordBody: true } }, async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    const body = updateAgentResourcesSchema.parse(request.body);
    return app.resourcesService.replaceAgentResources(request.params.uuid, body, scope.memberId);
  });
}
