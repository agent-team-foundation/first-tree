import type { FastifyInstance } from "fastify";

export async function contextTreeInfoRoutes(app: FastifyInstance): Promise<void> {
  /** Public endpoint — returns Context Tree repo metadata for CLI auto-discovery. */
  app.get("/info", async () => {
    const repo = app.config.contextTree?.repo ?? null;
    const branch = app.config.contextTree?.branch ?? null;
    return { repo, branch };
  });
}
