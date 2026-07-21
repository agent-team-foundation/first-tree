import type { FastifyInstance } from "fastify";

/**
 * Process liveness endpoint for container orchestration.
 * Used by Docker HEALTHCHECK, Railway, Fly.io, Kubernetes liveness probes.
 * Answers 200 from process memory only — no database round trip — so public
 * traffic cannot be amplified into PG load and a database outage never makes
 * an orchestrator restart a healthy process. Database readiness lives in
 * `/readyz`; a structured status body lives in `/api/v1/health`.
 */
export async function healthzRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });
}
