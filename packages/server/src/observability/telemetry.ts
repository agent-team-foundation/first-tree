/**
 * OpenTelemetry integration — vendor-neutral facade.
 *
 * Enable by configuring `observability.tracing.endpoint` (non-empty). All
 * functions here are safe to call when tracing is disabled — they become
 * no-ops so instrumented business code pays no cost.
 */

import { TRACING_SENSITIVE_KEY_PATTERNS } from "@agent-team-foundation/first-tree-hub-shared/observability";
import otelModule from "@fastify/otel";
import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter as OTLPHttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { createLogger, setErrorSink } from "./logger.js";

// CJS default-interop — `@fastify/otel` exports a class as the CJS default.
const { FastifyOtelInstrumentation } = otelModule as unknown as {
  FastifyOtelInstrumentation: new (opts?: {
    servername?: string;
    requestHook?: (span: Span, request: import("fastify").FastifyRequest) => void;
    ignoreHeaders?: string[];
  }) => {
    plugin: () => import("fastify").FastifyPluginCallback;
  };
};

/**
 * Headers the Fastify instrumentation must never capture. Even if upstream's
 * default changes to opt-in capture, we want an explicit blocklist so a
 * dependency bump can't quietly leak credentials into span attributes.
 */
const IGNORED_SPAN_HEADERS = ["authorization", "cookie", "set-cookie", "x-admin-token", "x-api-key"];

const log = createLogger("Telemetry");

export type TracingConfig = {
  endpoint: string;
  headers: string;
  exporter: "otlp-http" | "otlp-grpc";
  serviceName: string;
  environment: string;
  sampleRate: number;
};

let _enabled = false;
let _tracer: Tracer | null = null;
let _provider: NodeTracerProvider | null = null;
let _fastifyOtelPlugin: import("fastify").FastifyPluginCallback | null = null;

const TRACER_NAME = "@first-tree-hub/server";
const TRACER_VERSION = "0.1.0";

/**
 * Parse `key1=value1,key2=value2` into a header record. Preserves the first
 * `=` only so values containing `=` (e.g. base64) survive. Exported for unit tests.
 */
export function parseHeaderString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Initialize the OpenTelemetry SDK. When `config.endpoint` is empty tracing
 * stays disabled and every exported function becomes a no-op.
 *
 * `instanceId` — optional per-process identifier (Config.instanceId). When
 * provided it becomes the OTel resource attribute `service.instance.id`,
 * letting trace backends distinguish replicas of the same service even
 * when they share environment / region / etc.
 */
export async function initTelemetry(config: TracingConfig | undefined, instanceId?: string): Promise<void> {
  if (_provider) {
    // Second call — tear down old processor first so we don't leak BatchSpanProcessor
    // timers or pending export queues. Primarily guards tests and hot-reload code paths.
    log.warn("initTelemetry called twice; shutting down previous provider");
    await shutdownTelemetry();
  }

  if (!config || !config.endpoint) {
    log.info("tracing disabled (no endpoint configured)");
    return;
  }

  if (config.exporter === "otlp-grpc") {
    // Lazy: only require grpc package on demand; keeps it an optional dep.
    log.warn("otlp-grpc exporter requested but not bundled; falling back to otlp-http");
  }

  const exporter = new OTLPHttpExporter({
    url: config.endpoint,
    headers: parseHeaderString(config.headers),
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: TRACER_VERSION,
    "deployment.environment.name": config.environment,
    ...(instanceId ? { "service.instance.id": instanceId } : {}),
  });

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(config.sampleRate),
  });

  const provider = new NodeTracerProvider({
    resource,
    sampler,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register();

  _provider = provider;
  _tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  _enabled = true;

  // Prepare Fastify HTTP instrumentation plugin; app.ts registers it
  // conditionally via `getFastifyOtelPlugin()`.
  //
  // The `requestHook` is where we fix @fastify/otel's two default-behavior
  // annoyances: (1) every span is named literally "request", and (2)
  // `http.route` is set to the request URL (including path params) instead of
  // the route pattern (`/api/v1/sessions/:id`). Both hurt discoverability in
  // Logfire / Honeycomb / etc. We overwrite both here so spans render as
  // `GET /api/v1/sessions/:id → 200` and aggregate-by-route works.
  try {
    const instrumentation = new FastifyOtelInstrumentation({
      servername: config.serviceName,
      ignoreHeaders: IGNORED_SPAN_HEADERS,
      requestHook: (span, request) => {
        const route = request.routeOptions?.url;
        if (route) {
          span.updateName(`${request.method} ${route}`);
          span.setAttribute("http.route", route);
        } else {
          // No route match (404 path); fall back to method + raw URL sans query.
          const pathOnly = request.url.split("?")[0] ?? request.url;
          span.updateName(`${request.method} ${pathOnly}`);
        }
      },
    });
    _fastifyOtelPlugin = instrumentation.plugin();
  } catch (err) {
    log.warn({ err }, "failed to initialize @fastify/otel plugin; HTTP spans disabled");
  }

  // Wire error log bridge: pino error/fatal → active span exception
  setErrorSink((message, err, ctx) => {
    const span = trace.getActiveSpan();
    if (!span) return;
    const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : new Error(message);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    // Attach structured context as span attributes (redacted / normalized below)
    const attrs = normalizeAttrs(ctx);
    if (Object.keys(attrs).length > 0) span.setAttributes(attrs);
  });

  log.info(
    `tracing enabled: exporter=${config.exporter} endpoint=${truncateEndpoint(config.endpoint)} service=${config.serviceName} env=${config.environment}${instanceId ? ` instance=${instanceId}` : ""} sampleRate=${config.sampleRate}`,
  );
}

function truncateEndpoint(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function isTelemetryEnabled(): boolean {
  return _enabled;
}

/** Flush all pending spans. Call before `process.exit()` in shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  if (!_provider) return;
  setErrorSink(null);
  try {
    await _provider.shutdown();
  } catch {
    // don't block shutdown on exporter errors
  }
  _enabled = false;
  _tracer = null;
  _provider = null;
  _fastifyOtelPlugin = null;
}

/**
 * Returns the `@fastify/otel` plugin instance or null when tracing is
 * disabled. Consumers (app.ts) register this early so HTTP requests are
 * wrapped in spans before any route handler runs.
 */
export function getFastifyOtelPlugin(): import("fastify").FastifyPluginCallback | null {
  return _fastifyOtelPlugin;
}

// ─── Attribute normalization + redaction ──────────────────────────────

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACING_SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

export function normalizeAttrs(attrs?: Record<string, unknown>): Attributes {
  if (!attrs) return {};
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (isSensitiveKey(k)) {
      out[k] = "***";
      continue;
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v;
    } else {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}

// ─── Span facade ──────────────────────────────────────────────────────

/** Wrap an async function as a span. Records exceptions automatically. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!_tracer) return fn();
  return _tracer.startActiveSpan(name, { attributes: normalizeAttrs(attrs) }, async (span) => {
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
  });
}

/**
 * Start a span that must be ended manually. Useful for connection-lifecycle
 * or hook-pair patterns where the end point is not a lexical callback.
 *
 * If the caller does not intend to make the span the active context for
 * nested work, omit `makeActive`. When `makeActive=true`, pass the returned
 * `context` to `context.with(...)` for nested spans to auto-parent.
 */
export function startTrackedSpan(
  name: string,
  attrs?: Record<string, unknown>,
  options?: { kind?: SpanKind; parentContext?: Context },
): Span | null {
  if (!_tracer) return null;
  const parent = options?.parentContext ?? context.active();
  return _tracer.startSpan(name, { kind: options?.kind, attributes: normalizeAttrs(attrs) }, parent);
}

export function endSpan(span: Span | null, extraAttrs?: Record<string, unknown>, error?: Error): void {
  if (!span) return;
  if (extraAttrs) span.setAttributes(normalizeAttrs(extraAttrs));
  if (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
  span.end();
}

export function addSpanEvent(span: Span | null, name: string, attrs?: Record<string, unknown>): void {
  if (!span) return;
  span.addEvent(name, normalizeAttrs(attrs));
}

/** Record an error onto the currently-active span. */
export function reportError(message: string, err: unknown, extra?: Record<string, unknown>): void {
  if (!_enabled) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : new Error(message);
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  if (extra) span.setAttributes(normalizeAttrs(extra));
}

/** Current trace id, if any — used for `x-trace-id` response header. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  if (!ctx || !ctx.traceId || ctx.traceId === "00000000000000000000000000000000") return undefined;
  return ctx.traceId;
}

/** Current span id, if any — used for log correlation. */
export function currentSpanId(): string | undefined {
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  if (!ctx || !ctx.spanId || ctx.spanId === "0000000000000000") return undefined;
  return ctx.spanId;
}

/** Re-export for consumers that want to drive `context.with(...)` themselves. */
export { context, propagation, SpanKind, SpanStatusCode, trace };
