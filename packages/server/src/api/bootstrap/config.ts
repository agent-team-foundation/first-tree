import type { FastifyInstance } from "fastify";

export async function bootstrapConfigRoutes(app: FastifyInstance): Promise<void> {
  /** Public endpoint — returns bootstrap prerequisites for CLI auto-discovery. */
  app.get("/config", async () => {
    return {
      allowedOrg: app.config.github.allowedOrg ?? null,
    };
  });
}
