import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as agentService from "../../services/agent.js";
import * as presenceService from "../../services/presence.js";

export async function agentMeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) => {
    const identity = requireAgent(request);
    const [agent, presence] = await Promise.all([
      agentService.getAgent(app.db, identity.uuid),
      presenceService.getPresence(app.db, identity.uuid),
    ]);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
      // M1: runtime fields
      clientId: presence?.clientId ?? null,
      runtimeType: presence?.runtimeType ?? null,
      runtimeVersion: presence?.runtimeVersion ?? null,
      runtimeState: presence?.runtimeState ?? null,
      activeSessions: presence?.activeSessions ?? null,
      totalSessions: presence?.totalSessions ?? null,
    };
  });
}
