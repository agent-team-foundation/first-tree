/**
 * Logfire / OpenTelemetry bootstrap.
 *
 * This module replaces a previous hand-rolled `NodeTracerProvider` +
 * `BatchSpanProcessor` setup. The hand-rolled code repeatedly fought edge
 * cases in `@fastify/otel` (orphan hook spans on WS upgrades, sampling
 * decisions cascading the wrong way, attribute writes landing on hook
 * wrappers instead of the HTTP root). The Pydantic Logfire SDK (the same
 * project Python users invoke as `logfire`) ships a Node port that wraps
 * `@opentelemetry/sdk-node` + `auto-instrumentations-node` with sane
 * defaults, automatic attribute scrubbing, and a single `configure()` call.
 *
 * We disable the bundled fastify auto-instrumentation in favour of
 * `@autotelic/fastify-opentelemetry` (registered in `app.ts`) — that plugin
 * emits exactly one root span per HTTP request and lets us decorate it via
 * `request.openTelemetry().activeSpan`, avoiding the "wrap every hook"
 * pattern that produced the noisy `handler - async (app) => …` spans.
 *
 * All other moving parts (sampling, scrubbing, OTLP endpoint, headers)
 * come from the existing `config.observability.tracing.*` schema, so
 * deployments do not need to change `FIRST_TREE_HUB_OTEL_*` env vars.
 */

import { TRACING_SENSITIVE_KEY_PATTERNS } from "@first-tree/shared/observability";
import * as logfire from "@pydantic/logfire-node";
import { createLogger } from "./logger.js";
import { installPinoErrorBridge, uninstallPinoErrorBridge } from "./otel-helpers.js";

const log = createLogger("Telemetry");

const TRACER_VERSION = "0.1.0";

export type TracingConfig = {
  endpoint: string;
  headers: string;
  exporter: "otlp-http" | "otlp-grpc";
  serviceName: string;
  environment: string;
  sampleRate: number;
};

let _enabled = false;

/**
 * Parse `key1=value1,key2=value2` into a header record. Preserves the first
 * `=` only so values containing `=` (e.g. base64) survive. Exported for unit
 * tests + `logfire-init.ts` token extraction.
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
 * Reverse `https://logfire-us.pydantic.dev/v1/traces` to a base URL Logfire
 * accepts (`https://logfire-us.pydantic.dev`). For tokens that already
 * encode the region (`pylf_v1_us_…`) Logfire derives the URL itself, so this
 * is only consulted when callers point at a self-hosted instance.
 */
function deriveBaseUrl(endpoint: string): string | undefined {
  if (!endpoint) return undefined;
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Initialize the tracing pipeline. When `config.endpoint` is empty tracing
 * stays disabled and `withSpan` / `startTrackedSpan` etc. degrade to no-ops
 * via OTel's Noop tracer (the global TracerProvider stays at its default).
 *
 * `instanceId` — per-process identifier. Becomes `service.instance.id` so
 * trace backends can distinguish replicas of the same service.
 */
export async function initTelemetry(config: TracingConfig | undefined, instanceId?: string): Promise<void> {
  if (_enabled) {
    // Second call — Logfire's `shutdown()` tears down the SDK and lets a
    // fresh `configure()` install a new one. Mostly a guard for tests /
    // hot-reload.
    log.warn("initTelemetry called twice; shutting down previous Logfire SDK");
    await logfire.shutdown();
    _enabled = false;
  }

  if (!config || !config.endpoint) {
    log.info("tracing disabled (no endpoint configured)");
    return;
  }

  if (config.exporter === "otlp-grpc") {
    // Logfire only ships OTLP/HTTP. The hand-rolled SDK had the same
    // limitation; preserve the warning so operators with `otlp-grpc`
    // env-var defaults notice the fallback.
    log.warn("otlp-grpc exporter requested but Logfire SDK is HTTP-only; falling back to otlp-http");
  }

  // The exporter token Logfire uses lives inside the OTLP `Authorization`
  // header in our existing config, e.g. `Authorization=Bearer pylf_v1_us_…`.
  // Extract the bearer value so we can hand Logfire a plain token string.
  const headers = parseHeaderString(config.headers);
  const authHeader = headers.Authorization ?? headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    log.warn("tracing endpoint configured but no bearer token found in headers; tracing disabled");
    return;
  }

  // `LogfireConfigOptions` doesn't expose a `resourceAttributes` knob, but
  // the underlying NodeSDK respects the standard OTel env var. Set it
  // before `configure()` runs so `service.instance.id` lands on every
  // emitted span as a resource attribute.
  //
  // Snapshot the operator-provided value once and rebuild from that snapshot
  // on every call. Without this guard a hot-reloaded process (test harness,
  // dev `tsx watch`) would accumulate `service.instance.id=A,…=B,…=C` on
  // each reinit — OTel takes the last value so it works, but the env var
  // grows unboundedly and is ugly to inspect.
  if (instanceId) {
    const baseEnvKey = "__FIRST_TREE_HUB_OTEL_RESOURCE_ATTRIBUTES_BASE";
    const baseFromCache = process.env[baseEnvKey];
    const baseInitial = baseFromCache ?? process.env.OTEL_RESOURCE_ATTRIBUTES ?? "";
    if (baseFromCache === undefined) process.env[baseEnvKey] = baseInitial;
    const additions = `service.instance.id=${instanceId}`;
    process.env.OTEL_RESOURCE_ATTRIBUTES = baseInitial ? `${baseInitial},${additions}` : additions;
  }

  logfire.configure({
    token,
    serviceName: config.serviceName,
    serviceVersion: TRACER_VERSION,
    environment: config.environment,
    advanced: {
      baseUrl: deriveBaseUrl(config.endpoint),
    },
    sampling: { head: config.sampleRate },
    // Augment Logfire's default scrubber with our own list. Substring matched
    // case-insensitively against attribute keys; hits replaced with `[scrubbed]`.
    scrubbing: { extraPatterns: [...TRACING_SENSITIVE_KEY_PATTERNS] },
    // We're a tracing-first deployment — operators turn on Logfire to get
    // request-level traces, not the metrics or log streams. Logfire's default
    // is metrics=on; flip it off so enabling tracing doesn't quietly start
    // shipping a second telemetry signal nobody asked for. Operators who
    // want metrics can flip this back via a follow-up.
    metrics: false,
    // Auto-instrumentation policy. The bundled `auto-instrumentations-node`
    // 0.73 enables `instrumentation-http` by default, which would emit a
    // SERVER span per request alongside the `@autotelic/fastify-opentelemetry`
    // route span — producing two-layer spans on every HTTP request and an
    // extra "phantom" SERVER span that ends at HTTP 101 for every WS upgrade
    // (which our `ws.connection` long-running span is meant to represent).
    // Disable it: autotelic is the canonical HTTP server span in this app.
    //
    // Note: `auto-instrumentations-node` 0.73 does NOT include
    // `instrumentation-fastify` in its map, so the fastify routing layer is
    // never double-traced — autotelic owns it exclusively.
    //
    // `instrumentation-net` and `-dns` emit a span per TCP connection / DNS
    // lookup. Useful for low-level connection debugging, overwhelming at
    // production request volume.
    nodeAutoInstrumentations: {
      "@opentelemetry/instrumentation-http": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
    },
  });

  // Bridge pino error/fatal logs onto the active span as exception events.
  // Must run after `logfire.configure` so the global TracerProvider exists.
  installPinoErrorBridge();

  _enabled = true;
  log.info(
    `tracing enabled: endpoint=${truncateEndpoint(config.endpoint)} service=${config.serviceName} env=${config.environment}${instanceId ? ` instance=${instanceId}` : ""} sampleRate=${config.sampleRate}`,
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
  if (!_enabled) return;
  uninstallPinoErrorBridge();
  try {
    await logfire.shutdown();
  } catch {
    // don't block shutdown on exporter errors
  }
  _enabled = false;
}
