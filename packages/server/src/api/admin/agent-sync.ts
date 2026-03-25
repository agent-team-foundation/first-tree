import type { FastifyInstance } from "fastify";
import { getLastGraphQLSyncResult, syncFromGitHub } from "../../services/context-tree-graphql.js";

export async function adminAgentSyncRoutes(app: FastifyInstance): Promise<void> {
  // Trigger manual sync
  app.post("/", async (_request, reply) => {
    const { repo, branch } = app.config.contextTree;
    const { token } = app.config.github;
    try {
      const result = await syncFromGitHub(app.db, repo, branch, token);
      return reply.send({ summary: result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      app.log.error(error, "Context Tree sync failed");
      return reply.status(502).send({ error: msg });
    }
  });

  // Get most recent sync status
  app.get("/status", async (_request, reply) => {
    const lastSync = getLastGraphQLSyncResult();
    return reply.send({ lastSync: lastSync ?? null });
  });
}
