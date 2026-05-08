export { FIRST_TREE_HUB_ATTR } from "@agent-team-foundation/first-tree-hub-shared/observability";
export { observabilityPlugin } from "./fastify-plugin.js";
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
export { attachRequestContext, bodyCaptureOnSendHook, reportErrorToRoot } from "./request-context.js";
export { adapterAttrs, agentAttrs, chatAttrs, inboxAttrs, messageAttrs } from "./span-attrs.js";
export { endWsConnectionSpan, setWsConnectionAttrs, startWsConnectionSpan, withWsMessageSpan } from "./ws-tracing.js";
