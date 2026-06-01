import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Resolve First Tree's public-facing base URL.
 *
 * Precedence:
 *   1. `app.config.server.publicUrl` — explicit configuration. Required in
 *      production (the boot check enforces it).
 *   2. The request's `Host` header (with `X-Forwarded-Proto` honored) —
 *      dev fallback so local quickstart works without extra config.
 *
 * Result is normalized to drop trailing slashes so callers can append
 * paths with a single leading `/`.
 */
export function resolvePublicUrl(app: FastifyInstance, request: FastifyRequest): string {
  const configured = app.config.server.publicUrl;
  if (configured && configured.length > 0) {
    return configured.replace(/\/+$/, "");
  }
  const proto = pickHeader(request.headers["x-forwarded-proto"]) ?? request.protocol;
  const host = pickHeader(request.headers["x-forwarded-host"]) ?? pickHeader(request.headers.host) ?? request.hostname;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
