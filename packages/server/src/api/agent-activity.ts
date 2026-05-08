import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import * as activityService from "../services/activity.js";

/** Class C — `/api/v1/agents/:uuid/reset-activity`. */
export async function agentActivityRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { uuid: string } }>("/:uuid/reset-activity", async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    await activityService.resetActivity(app.db, request.params.uuid);
    return { reset: true };
  });
}
