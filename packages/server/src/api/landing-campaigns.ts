import { landingCampaignStartRequestSchema, landingCampaignStartResponseSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../scope/require-user.js";
import { startLandingCampaignTrial } from "../services/landing-campaigns/start.js";

export async function landingCampaignRoutes(app: FastifyInstance): Promise<void> {
  app.post("/start", { config: { otelRecordBody: true } }, async (request, reply) => {
    const { userId } = requireUser(request);
    if (!app.config.growth.landingPagesEnabled) {
      return reply
        .status(404)
        .send({ error: "Growth landing pages are disabled on this First Tree deployment.", code: "feature_disabled" });
    }
    const body = landingCampaignStartRequestSchema.parse(request.body);
    const result = await startLandingCampaignTrial(app, userId, body);
    return reply.status(200).send(landingCampaignStartResponseSchema.parse(result));
  });
}
