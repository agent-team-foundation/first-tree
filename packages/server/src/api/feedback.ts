import type { FastifyInstance, FastifyRequest } from "fastify";
import { createFeedbackHandler, type FeedbackHandlerConfig } from "hearback-server";

/**
 * Resolve the client IP for rate-limit attribution.
 *
 * Headers like `x-forwarded-for` are client-controllable, so we only trust
 * them when the operator explicitly opts in via `HEARBACK_TRUST_PROXY_HEADERS=true`.
 * Otherwise fall back to Fastify's `req.ip` (socket-level) — degrades to one
 * bucket per upstream proxy, which is correct when no proxy metadata is
 * trustworthy.
 */
function resolveClientIp(req: FastifyRequest, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : typeof xff === "string" ? xff.split(",")[0] : undefined;
    if (first && first.trim().length > 0) return first.trim();
  }
  return req.ip ?? "";
}

export type FeedbackRouteConfig = FeedbackHandlerConfig & {
  trustProxyHeaders: boolean;
};

/**
 * Mount the hearback-server handler onto Fastify. Register with
 * `{ prefix: "/feedback" }` so the widget's default `data-endpoint="/feedback"`
 * resolves to `/feedback/chat`, `/feedback/submit`, `/feedback/upload`, etc.
 *
 * We don't use hearback's prebuilt `feedbackPlugin` because it expects the
 * `fastify-raw-body` plugin. This adapter uses `addContentTypeParser` with
 * `parseAs: "buffer"` on an encapsulated child instance so upload bytes reach
 * the handler as a Buffer without pulling in another dependency.
 */
export async function feedbackRoutes(app: FastifyInstance, config: FeedbackRouteConfig): Promise<void> {
  const { trustProxyHeaders, ...handlerConfig } = config;
  const handler = createFeedbackHandler(handlerConfig);

  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.all("/*", async (req, reply) => {
    const path = req.url.replace(/^.*\/feedback/, "").split("?")[0] || "/";
    const ip = resolveClientIp(req, trustProxyHeaders);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v[0] : v;
    }
    const isUpload = path.replace(/\/$/, "").endsWith("/upload");
    const rawBody = isUpload && Buffer.isBuffer(req.body) ? req.body : undefined;
    const result = await handler.handle({
      method: req.method,
      path,
      body: isUpload ? {} : req.body,
      ip,
      headers,
      rawBody,
    });
    reply.status(result.status).headers(result.headers);
    if (result.body && typeof result.body === "object" && Symbol.asyncIterator in result.body) {
      const stream = result.body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        reply.raw.write(chunk);
      }
      reply.raw.end();
      return;
    }
    if (result.body === null) {
      reply.send();
    } else {
      reply.send(result.body);
    }
  });
}
