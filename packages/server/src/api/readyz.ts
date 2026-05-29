import type { FastifyInstance } from "fastify";
import { bootstrapState } from "../bootstrap-state.js";

/**
 * Required bootstrap stages for readiness. `appListen` is the last stage and
 * the one that flips `bootstrapState.readyAt`; the others must be `done` too
 * so a partial-failure boot (e.g. migrations finished but listen timed out)
 * still reports the offending stage in the body.
 */
const REQUIRED_STAGES = ["initTelemetry", "runMigrations", "buildApp", "appListen"] as const;

/**
 * Readiness endpoint — distinct from `/healthz` (liveness). Returns 200 only
 * when every bootstrap stage is done. The body carries the stage detail so
 * operators can see which stage stalled. See
 * docs/server-bootstrap-resilience-design.md §3 (T6).
 */
export async function readyzRoutes(app: FastifyInstance): Promise<void> {
  app.get("/readyz", { config: { rateLimit: false } }, async (_request, reply) => {
    const allStagesDone = REQUIRED_STAGES.every((s) => bootstrapState.stages[s]?.status === "done");
    const ready = allStagesDone && bootstrapState.readyAt !== null;

    const body = {
      ready,
      startedAt: bootstrapState.startedAt.toISOString(),
      readyAt: bootstrapState.readyAt?.toISOString() ?? null,
      stages: bootstrapState.stages,
    };
    return reply.status(ready ? 200 : 503).send(body);
  });
}
