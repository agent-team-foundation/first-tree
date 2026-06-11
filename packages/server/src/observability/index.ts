export { FIRST_TREE_ATTR } from "@first-tree/shared/observability";
export { observabilityPlugin } from "./fastify-plugin.js";
export {
  classifyJoseError,
  decodeJwtForTrace,
  type JwtFailureReason,
  type UntrustedJwtClaims,
  untrustedAttrs,
} from "./jwt-trace.js";
export {
  initTelemetry,
  isTelemetryEnabled,
  parseHeaderString,
  shutdownTelemetry,
  type TracingConfig,
} from "./logfire-init.js";
export { applyLoggerConfig, createLogger, rootLogger, setErrorSink } from "./logger.js";
export {
  addSpanEvent,
  context,
  currentSpanId,
  currentTraceId,
  endSpan,
  normalizeAttrs,
  propagation,
  reportError,
  SpanKind,
  SpanStatusCode,
  startTrackedSpan,
  trace,
  withSpan,
} from "./otel-helpers.js";
export { buildRateLimitError, stampRateLimitAttrs } from "./rate-limit-error-builder.js";
export { attachRequestContext, bodyCaptureOnSendHook, reportErrorToRoot } from "./request-context.js";
export { agentAttrs, chatAttrs, inboxAttrs, messageAttrs } from "./span-attrs.js";
export { endWsConnectionSpan, setWsConnectionAttrs, startWsConnectionSpan, withWsMessageSpan } from "./ws-tracing.js";
