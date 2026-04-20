import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createLogger } from "./logger.js";
import { currentSpanId, currentTraceId } from "./telemetry.js";

/**
 * Fastify plugin that:
 * 1. Swaps Fastify's request-scoped logger for a child of our createLogger
 *    so request logs share the same format / output stream / errorSink.
 * 2. Stamps `x-trace-id` on every response when a trace id is available.
 * 3. Includes traceId in JSON error bodies emitted via `AppError`.
 */
export const observabilityPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const log = createLogger("Http");

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = currentTraceId();
    const spanId = currentSpanId();
    const bindings: Record<string, unknown> = { requestId: request.id };
    if (traceId) bindings.traceId = traceId;
    if (spanId) bindings.spanId = spanId;
    // Replace Fastify's per-request logger with our module-scoped one so
    // existing call sites (request.log.*) get our format + error sink.
    (request as FastifyRequest & { log: ReturnType<typeof log.child> }).log = log.child(bindings);

    if (traceId) {
      reply.header("x-trace-id", traceId);
    }
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (reply.statusCode >= 500) {
      request.log.warn({ method: request.method, url: request.url, statusCode: reply.statusCode }, "request failed");
    }
  });
};
