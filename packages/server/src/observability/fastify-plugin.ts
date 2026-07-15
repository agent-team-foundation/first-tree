import { redactUrl } from "@first-tree/shared/observability";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createLogger } from "./logger.js";
import { currentTraceId } from "./otel-helpers.js";

/**
 * Fastify plugin that:
 * 1. Swaps Fastify's request-scoped logger for a child of our createLogger
 *    so request logs share the same format / output stream / errorSink.
 * 2. Stamps `x-trace-id` on every response when a trace id is available.
 * 3. Includes traceId in JSON error bodies emitted via `AppError`.
 *
 * We deliberately only bind `traceId` (stable for the whole request) — not
 * `spanId`, which changes when handlers enter `withSpan(...)`. Binding it at
 * onRequest would freeze it to the HTTP root span, mis-attributing later
 * logs to the wrong span. Call sites that want the current span id can use
 * `currentSpanId()` directly.
 */
export const observabilityPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const log = createLogger("Http");

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = currentTraceId();
    const bindings: Record<string, unknown> = { requestId: request.id };
    if (traceId) bindings.traceId = traceId;
    (request as FastifyRequest & { log: ReturnType<typeof log.child> }).log = log.child(bindings);

    if (traceId) {
      reply.header("x-trace-id", traceId);
    }
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (reply.statusCode >= 500) {
      request.log.warn(
        { method: request.method, url: redactUrl(request.url), statusCode: reply.statusCode },
        "request failed",
      );
    }
  });
};
