export { FIRST_TREE_HUB_ATTR } from "@agent-team-foundation/first-tree-hub-shared/observability";
export { observabilityPlugin } from "./fastify-plugin.js";
export { applyLoggerConfig, createLogger, rootLogger, setErrorSink } from "./logger.js";
export { adapterAttrs, agentAttrs, chatAttrs, inboxAttrs, messageAttrs } from "./span-attrs.js";
export {
  addSpanEvent,
  context,
  currentSpanId,
  currentTraceId,
  endSpan,
  getFastifyOtelPlugin,
  initTelemetry,
  isContentCaptureEnabled,
  isTelemetryEnabled,
  normalizeAttrs,
  propagation,
  reportError,
  SpanKind,
  SpanStatusCode,
  shutdownTelemetry,
  startTrackedSpan,
  type TracingConfig,
  trace,
  withSpan,
} from "./telemetry.js";
export {
  endWsConnectionSpan,
  getWsConnectionContext,
  setWsConnectionAttrs,
  startWsConnectionSpan,
  withWsMessageSpan,
} from "./ws-tracing.js";
