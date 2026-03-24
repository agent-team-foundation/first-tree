import type { FastifyInstance } from "fastify";
import { getLastSyncReport, syncAgents } from "../../services/agent-sync.js";

export async function adminAgentSyncRoutes(app: FastifyInstance): Promise<void> {
  // Trigger manual sync
  app.post("/", async (_request, reply) => {
    const report = await syncAgents(app.db, app.config.contextTreePath);
    return reply.send(report);
  });

  // Get most recent sync status
  app.get("/status", async (_request, reply) => {
    const lastSync = getLastSyncReport();
    return reply.send({ lastSync });
  });
}
