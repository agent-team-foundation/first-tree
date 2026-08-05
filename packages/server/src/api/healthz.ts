import type { FastifyInstance } from "fastify";

/**
 * Root-level process liveness endpoint for container orchestration.
 * If the event loop can serve this handler, the process is live. Database
 * reachability belongs to `/readyz` and must not make liveness restart-loop.
 */
export async function healthzRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { config: { rateLimit: false } }, (_request, reply) => reply.status(200).send({ status: "ok" }));
}
