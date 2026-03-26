import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

/**
 * Root-level health check endpoint for container orchestration.
 * Returns 200 when healthy, 503 when degraded.
 * Used by Docker HEALTHCHECK, Railway, Fly.io, Kubernetes liveness/readiness probes.
 */
export async function healthzRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await app.db.execute(sql`SELECT 1`);
      return reply.status(200).send({ status: "ok" });
    } catch {
      return reply.status(503).send({ status: "error", message: "database unreachable" });
    }
  });
}
