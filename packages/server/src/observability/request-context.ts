/**
 * Hooks that enrich the HTTP root span emitted by
 * `@autotelic/fastify-opentelemetry` with our domain-specific attributes.
 *
 * `@autotelic/fastify-opentelemetry` decorates every request with
 * `request.openTelemetry()` returning `{ activeSpan, context, tracer, ... }`
 * — `activeSpan` is the single root span for the request, ended on
 * `onResponse`. Reading it here is preferable to `trace.getActiveSpan()`,
 * which inside hooks can return whatever transient async-context span the
 * runtime happens to be inside (a previously-leaked source of bugs where
 * `user.id` etc. landed on a hook wrapper span instead of the route row).
 */

import { FIRST_TREE_ATTR } from "@first-tree/shared/observability";
import type { Span } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { normalizeAttrs } from "./otel-helpers.js";

type AutotelicAccessor = () => { activeSpan: Span | null; tracer: unknown; context: unknown };

/**
 * Read the HTTP root span off the request via the autotelic plugin's
 * `request.openTelemetry()` decorator. Returns `undefined` if the plugin
 * isn't loaded or the route opted out — in either case downstream hooks
 * become no-ops and never accidentally write to a stray async-context span.
 */
function rootSpanOf(request: FastifyRequest): Span | undefined {
  const r = request as FastifyRequest & { openTelemetry?: AutotelicAccessor };
  if (typeof r.openTelemetry !== "function") return undefined;
  try {
    return r.openTelemetry().activeSpan ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tag the HTTP root span with the authenticated identity. Reads
 * `request.user` (set by `userAuthHook`) and `request.agent` (set by
 * `agentSelectorHook`); skips fields that aren't populated, so it's safe to
 * register on routes where one or both upstream hooks did not run.
 *
 * Org / member / role attributes flow through `stampOrgScope` from the
 * scope helpers (`requireOrgMembership`, `requireAgentAccess`, …) — the
 * JWT no longer carries them, and stamping on the auth hook would require
 * duplicating the per-request DB lookup the scope helpers already do.
 */
export async function attachRequestContext(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const span = rootSpanOf(request);
  if (!span) return;

  if (request.user) {
    span.setAttribute(FIRST_TREE_ATTR.USER_ID, request.user.userId);
  }

  if (request.agent) {
    span.setAttribute(FIRST_TREE_ATTR.AGENT_ID, request.agent.uuid);
    if (request.agent.clientId) {
      span.setAttribute(FIRST_TREE_ATTR.CLIENT_ID, request.agent.clientId);
    }
    span.setAttribute("agent.inbox_id", request.agent.inboxId);
  }
}

/**
 * Stamp the resolved org membership onto the HTTP root span. Called from
 * every scope helper (`requireOrgMembership`, `requireOrgAdmin`,
 * `requireAgentAccess`, `requireChatAccess`) after the DB lookup succeeds.
 *
 * Centralizing here (vs duplicating `span.setAttribute` calls in each scope
 * helper) keeps the attribute-key namespace consistent and lets us add new
 * tags (e.g. plan tier) in one place.
 */
export function stampOrgScope(
  request: FastifyRequest,
  scope: { organizationId: string; memberId: string; role: string },
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.ORGANIZATION_ID, scope.organizationId);
  span.setAttribute(FIRST_TREE_ATTR.MEMBER_ID, scope.memberId);
  span.setAttribute(FIRST_TREE_ATTR.USER_ROLE, scope.role);
}

/**
 * Stamp the resolved agent resource onto the HTTP root span. Called from
 * `requireAgentAccess` (Class C `/agents/:uuid/...` routes) so the span has
 * the agent identity even though `request.agent` is only set on Class D
 * runtime-self routes.
 */
export function stampAgentResource(
  request: FastifyRequest,
  agent: { uuid: string; inboxId: string; clientId?: string | null },
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.AGENT_ID, agent.uuid);
  if (agent.clientId) {
    span.setAttribute(FIRST_TREE_ATTR.CLIENT_ID, agent.clientId);
  }
  span.setAttribute("agent.inbox_id", agent.inboxId);
}

/**
 * Stamp the resolved client resource onto the HTTP root span. Client resource
 * routes carry `:clientId` directly in the URL rather than through the agent
 * selector, so they use this helper instead of `request.agent`.
 */
export function stampClientResource(request: FastifyRequest, clientId: string): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.CLIENT_ID, clientId);
}

/**
 * Stamp the resolved chat resource onto the HTTP root span. Called from
 * `requireChatAccess` (Class C `/chats/:chatId/...` routes).
 */
export function stampChatResource(request: FastifyRequest, chat: { id: string; type: string }): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.CHAT_ID, chat.id);
  span.setAttribute(FIRST_TREE_ATTR.CHAT_TYPE, chat.type);
}

/**
 * Configure body capture for a route. Set `config: { otelRecordBody: true }`
 * on a route to enable the body capture onSend hook below for that route.
 */
declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * When true, `bodyCaptureOnSendHook` records the parsed `request.body`
     * and `request.query` onto the active OTel span — but **only** when the
     * response status is >= 400, so the success path stays slim.
     * Sensitive keys (`token`, `password`, etc.) are redacted by
     * `normalizeAttrs` via `TRACING_SENSITIVE_KEY_PATTERNS`.
     */
    otelRecordBody?: boolean;
  }
}

/**
 * Maximum serialized body length attached to a span. 4 KiB is enough to see
 * the structure of any JSON request our APIs accept; longer payloads (like
 * file uploads) are truncated with a `…[truncated N chars]` marker.
 */
const MAX_BODY_ATTR_LEN = 4096;

/**
 * onSend hook that records redacted request body / query string for
 * routes that opted in via `config.otelRecordBody`. Records on **failures
 * only** (`statusCode >= 400`) so the production path doesn't pay a
 * permanent body-capture tax.
 *
 * Registered globally in `buildApp`; gated per-route by
 * `request.routeOptions.config?.otelRecordBody`.
 *
 * **Redaction caveat — TOP-LEVEL ONLY.** `normalizeAttrs` applies sensitive-key
 * matching only to top-level keys; nested objects are JSON-serialized whole,
 * so a sensitive field buried inside a nested object would survive.
 * Currently every opt-in route's body is flat (`/auth/login`, `/auth/refresh`,
 * `/auth/connect-token`, `/messages` …), so this is fine. Before flagging a
 * NEW route with `otelRecordBody: true`, confirm the body is flat — or pre-
 * redact in the handler before throwing — until/unless we move to a
 * recursive scrubber. Logfire's own scrubber (configured in `logfire-init.ts`)
 * is a second-line defence on the export side.
 */
export async function bodyCaptureOnSendHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if (!request.routeOptions?.config?.otelRecordBody) return payload;
  if (reply.statusCode < 400) return payload;

  const span = rootSpanOf(request);
  if (!span) return payload;

  if (request.body && typeof request.body === "object") {
    const redacted = normalizeAttrs(request.body as Record<string, unknown>);
    const serialized = JSON.stringify(redacted);
    span.setAttribute(
      FIRST_TREE_ATTR.HTTP_REQUEST_BODY,
      serialized.length <= MAX_BODY_ATTR_LEN
        ? serialized
        : `${serialized.slice(0, MAX_BODY_ATTR_LEN)}…[truncated ${serialized.length - MAX_BODY_ATTR_LEN} chars]`,
    );
  }

  if (request.query && typeof request.query === "object" && Object.keys(request.query).length > 0) {
    const redacted = normalizeAttrs(request.query as Record<string, unknown>);
    for (const [k, v] of Object.entries(redacted)) {
      span.setAttribute(`http.query.${k}`, v as string | number | boolean);
    }
  }

  return payload;
}

/**
 * Stamp an exception + attributes onto the HTTP root span via the autotelic
 * decorator. Invariant: only call from inside fastify hook chains
 * (errorHandler / onSend / onError) where `request.openTelemetry()` is
 * decorated and the root span has not yet been ended.
 */
export function reportErrorToRoot(
  request: FastifyRequest,
  message: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : new Error(message);
  span.recordException(error);
  // Note: autotelic's onResponse will overwrite OK status iff statusCode<500;
  // we still record the exception+attrs so the failure surfaces in trace
  // backends as an exception event.
  if (extra) span.setAttributes(normalizeAttrs(extra));
}
