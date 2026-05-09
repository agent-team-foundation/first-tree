import type { Span } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import { decodeJwtForTrace, untrustedAttrs } from "./jwt-trace.js";

/**
 * Routes whose request body contains a JWT in `refreshToken` / `token`.
 * Used to gate the body-sniff in {@link buildRateLimitError} so unrelated
 * routes that happen to add a `token` field in the future won't get their
 * 429 trace polluted with bogus untrusted-decode attempts.
 */
const TOKEN_BODY_ROUTES = new Set<string>(["/api/v1/auth/refresh", "/api/v1/auth/connect-token"]);

export type RateLimitContext = {
  max: number;
  ttl: number;
};

/**
 * Constructs the `Error` instance that `@fastify/rate-limit` will throw on
 * a 429. Two side effects happen here that aren't trivial to express via
 * the limiter's default builder:
 *
 *   1. Stamp `rate_limit.{max,ttl_ms}` onto the active root span. The
 *      limiter short-circuits before our handler runs, so without this
 *      the 429 trace has no rate-limit metadata at all (issue #246).
 *   2. For `/auth/refresh` and `/auth/connect-token` only, opportunistically
 *      decode the JWT in the request body (without verifying signature)
 *      and stamp `auth.untrusted.sub` onto the same span — gives operators
 *      the same `sub` pivot they get on a matching 401, so 429 storms can
 *      be answered "1 looping client or N independent clients?".
 *
 * The returned value MUST be an `Error` instance — `@fastify/rate-limit`
 * throws it, and our `setErrorHandler` only honours the `statusCode`
 * branch when `error instanceof Error`. A plain object falls through to
 * the 500 generic branch.
 *
 * `exception.type` / `exception.message` are NOT stamped here: when our
 * `setErrorHandler` catches this, `reportErrorToRoot` calls
 * `span.recordException(err)` which sets those (OTel SDK convention)
 * using `error.name` / `error.message`. Stamping them here too would be
 * either redundant (same value) or overwritten (different value).
 */
export function buildRateLimitError(
  request: Pick<FastifyRequest, "openTelemetry" | "body" | "routeOptions">,
  context: RateLimitContext,
): Error {
  const span = request.openTelemetry().activeSpan;
  if (span) stampRateLimitAttrs(span, request, context);
  const message = `Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)} seconds`;
  const err = new Error(message);
  err.name = "RateLimitError";
  Object.assign(err, { statusCode: 429 });
  return err;
}

/**
 * Exported for unit testing. Pure side-effect function on `span` —
 * everything observable is the set of `setAttribute` calls.
 */
export function stampRateLimitAttrs(
  span: Pick<Span, "setAttribute">,
  request: Pick<FastifyRequest, "body" | "routeOptions">,
  context: RateLimitContext,
): void {
  span.setAttribute("rate_limit.max", context.max);
  span.setAttribute("rate_limit.ttl_ms", context.ttl);

  // Body sniff is only safe on routes whose contract names a JWT field.
  // Without the gate, a future POST /api/v1/foo with body `{token: "<opaque>"}`
  // would have its 429 trace decorated with garbage `auth.untrusted.*` attrs.
  const route = request.routeOptions?.url;
  if (!route || !TOKEN_BODY_ROUTES.has(route)) return;

  const body = request.body;
  if (!body || typeof body !== "object") return;
  const candidate =
    "refreshToken" in body && typeof (body as { refreshToken?: unknown }).refreshToken === "string"
      ? (body as { refreshToken: string }).refreshToken
      : "token" in body && typeof (body as { token?: unknown }).token === "string"
        ? (body as { token: string }).token
        : null;
  if (!candidate) return;

  const untrusted = decodeJwtForTrace(candidate);
  for (const [k, v] of Object.entries(untrustedAttrs("auth", untrusted))) {
    span.setAttribute(k, v);
  }
}
