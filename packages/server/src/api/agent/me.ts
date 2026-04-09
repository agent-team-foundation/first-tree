import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as agentService from "../../services/agent.js";

export async function agentMeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) => {
    const identity = requireAgent(request);
    const agent = await agentService.getAgent(app.db, identity.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });
}
