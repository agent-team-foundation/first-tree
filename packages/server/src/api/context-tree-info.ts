import type { FastifyInstance } from "fastify";

export async function contextTreeInfoRoutes(app: FastifyInstance): Promise<void> {
  /** Public endpoint — returns Context Tree repo metadata for CLI auto-discovery. */
  app.get("/info", async () => {
    const { repo, branch } = app.config.contextTree;
    return {
      repo,
      branch,
      lastSync: null, // TODO: track last sync timestamp in DB if needed
    };
  });
}
