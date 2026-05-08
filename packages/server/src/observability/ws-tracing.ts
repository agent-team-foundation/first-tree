/**
 * WebSocket trace helpers.
 *
 * WS doesn't fit cleanly into OTel's request/response model. We adopt two
 * span lifecycles:
 *
 * 1. **Connection span** — one long-running span per WS connection, opened
 *    when a socket is accepted and closed when the socket closes. Carries
 *    `client.id`, `agent.id` and close code as attributes.
 *
 * 2. **Message span** — short span per inbound WS message, parented to the
 *    connection span via an OTel Context captured at connect time. Use
 *    `withWsMessageSpan()` around each message handler body.
 *
 * When tracing is disabled every function degrades to a transparent no-op.
 */

import { FIRST_TREE_HUB_ATTR } from "@agent-team-foundation/first-tree-hub-shared/observability";
import type { Context, Span } from "@opentelemetry/api";
import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import type { WebSocket } from "ws";
import { getServerTracer, normalizeAttrs, startTrackedSpan } from "./otel-helpers.js";

type ConnectionEntry = {
  span: Span;
  context: Context;
};

const connections = new WeakMap<WebSocket, ConnectionEntry>();

/**
 * Begin a connection-scoped span. Call once right after the socket is accepted.
 * The returned handle is optional — callers that just want the
 * `withWsMessageSpan` linkage don't need to hold onto it.
 */
export function startWsConnectionSpan(
  socket: WebSocket,
  attrs: {
    clientId?: string;
    organizationId?: string;
    remoteIp?: string;
  } = {},
): void {
  const span = startTrackedSpan("ws.connection", {
    [FIRST_TREE_HUB_ATTR.CLIENT_ID]: attrs.clientId,
    [FIRST_TREE_HUB_ATTR.ORGANIZATION_ID]: attrs.organizationId,
    [FIRST_TREE_HUB_ATTR.WS_REMOTE_IP]: attrs.remoteIp,
  });
  if (!span) return;
  const ctx = trace.setSpan(otelContext.active(), span);
  connections.set(socket, { span, context: ctx });
}

/** Set additional attributes on the connection span (e.g. agentId discovered after bind). */
export function setWsConnectionAttrs(socket: WebSocket, attrs: Record<string, unknown>): void {
  const entry = connections.get(socket);
  if (!entry) return;
  entry.span.setAttributes(normalizeAttrs(attrs));
}

/** End the connection span with an optional close code. Safe to call on every close path. */
export function endWsConnectionSpan(socket: WebSocket, closeCode?: number): void {
  const entry = connections.get(socket);
  if (!entry) return;
  if (closeCode !== undefined) {
    entry.span.setAttributes({ [FIRST_TREE_HUB_ATTR.WS_CLOSE_CODE]: closeCode });
  }
  entry.span.end();
  connections.delete(socket);
}

/**
 * Run a handler inside a span parented to the connection span. If tracing is
 * disabled or no connection span exists, the handler runs unwrapped.
 *
 * `heartbeat` frames are excluded — a long-lived WS connection emits one
 * every 30s with no debug value (~2.8k spans/day per client, all identical).
 * The connection-level span captures abnormal closures, so we don't lose
 * "heartbeats stopped" visibility by skipping these.
 */
export async function withWsMessageSpan<T>(
  socket: WebSocket,
  type: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (type === "heartbeat") return fn();
  const entry = connections.get(socket);
  if (!entry) return fn();
  const tracer = getServerTracer();
  const spanName = `ws.message ${type}`;
  return otelContext.with(entry.context, () =>
    tracer.startActiveSpan(
      spanName,
      { attributes: normalizeAttrs({ [FIRST_TREE_HUB_ATTR.WS_MESSAGE_TYPE]: type, ...attrs }) },
      async (span) => {
        try {
          const result = await fn();
          span.end();
          return result;
        } catch (err) {
          if (err instanceof Error) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          }
          span.end();
          throw err;
        }
      },
    ),
  );
}
