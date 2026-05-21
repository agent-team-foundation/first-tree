/**
 * Span behaviour tests with an in-memory exporter.
 *
 * Why a separate file from `otel-init.test.ts`: this suite installs a real
 * `BasicTracerProvider` + `InMemorySpanExporter` as the global tracer
 * provider. The `otel-init.test.ts` lifecycle tests deliberately stay in the
 * "no global provider" world so they exercise the noop fallback. Mixing the
 * two in one file would either leave a dirty global between tests or force
 * fragile ordering.
 *
 * Goal: regression-protect the contracts our error-path observability
 * relies on, without booting the real Logfire SDK (whose 30s flush timeout
 * makes lifecycle tests slow + flaky in CI).
 */

import { FIRST_TREE_HUB_ATTR } from "@first-tree/shared/observability";
import { context as otelContext, type Span, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentSpanId, currentTraceId, withSpan } from "../otel-helpers.js";
import { bodyCaptureOnSendHook } from "../request-context.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
// `BasicTracerProvider` registers a TracerProvider but not a ContextManager.
// Without one the OTel API's `context.active()` always returns ROOT_CONTEXT,
// so `tracer.startActiveSpan(...)` cannot make its span the active span in
// the callback — `currentTraceId()` would always be undefined. The full Node
// SDK installs `AsyncHooksContextManager` for us; here we install it
// manually so the API contract under test matches production.
const contextManager = new AsyncHooksContextManager();

beforeAll(() => {
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  otelContext.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
});

describe("currentTraceId / currentSpanId", () => {
  it("return undefined when no span is active", () => {
    // Outside any `tracer.startActiveSpan` callback the OTel context has no
    // span, so both helpers must report `undefined` (not "" / not the
    // sentinel "00000000…00") — `app.ts` and `request-context.ts` rely on
    // that to skip stamping `x-trace-id` headers / response bodies when
    // there is no real trace to point at.
    expect(currentTraceId()).toBeUndefined();
    expect(currentSpanId()).toBeUndefined();
  });

  it("return the active trace + span ids inside a `withSpan` callback", async () => {
    let captured: { traceId?: string; spanId?: string } | undefined;
    await withSpan("test-current-ids", undefined, async () => {
      captured = { traceId: currentTraceId(), spanId: currentSpanId() };
    });
    expect(captured?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(captured?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("withSpan exception recording", () => {
  it("records the thrown error as an exception event and re-throws", async () => {
    const boom = new Error("kaboom");
    await expect(
      withSpan("test-throw", undefined, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (!span) throw new Error("unreachable: length asserted above");
    expect(span.name).toBe("test-throw");
    // OTel's `recordException` emits a single span event named "exception"
    // carrying `exception.type` / `exception.message` attributes. Asserting
    // the event presence + payload is what guarantees the trace backend
    // (Logfire / Honeycomb / Tempo) can render the failure as an error
    // even though autotelic resets 4xx span status to OK on the way out.
    const exceptionEvents = span.events.filter((e) => e.name === "exception");
    expect(exceptionEvents).toHaveLength(1);
    expect(exceptionEvents[0]?.attributes?.["exception.type"]).toBe("Error");
    expect(exceptionEvents[0]?.attributes?.["exception.message"]).toBe("kaboom");
    expect(span.status.code).toBe(2 /* SpanStatusCode.ERROR */);
  });
});

describe("bodyCaptureOnSendHook", () => {
  // Build a minimal FastifyRequest stand-in with `openTelemetry()` returning
  // `activeSpan: <span>`. autotelic's full decorator surface isn't needed —
  // the hook only reads `activeSpan`.
  function makeRequestWith(
    span: Span,
    routeConfig: Record<string, unknown> | undefined,
    body: unknown,
    query?: Record<string, unknown>,
  ): FastifyRequest {
    return {
      routeOptions: { config: routeConfig },
      body,
      query,
      openTelemetry: () => ({ activeSpan: span, tracer: null, context: otelContext.active() }),
    } as unknown as FastifyRequest;
  }

  function makeReply(statusCode: number): FastifyReply {
    return { statusCode } as unknown as FastifyReply;
  }

  function findFinished(traceId: string): ReadableSpan {
    const finished = exporter.getFinishedSpans().find((s) => s.spanContext().traceId === traceId);
    if (!finished) throw new Error("expected matching finished span, got none");
    return finished;
  }

  it("redacts sensitive top-level keys before stamping http.request.body", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(
      span,
      { otelRecordBody: true },
      { username: "alice", password: "hunter2", refreshToken: "eyJabc.def.ghi", remember: true },
    );
    await bodyCaptureOnSendHook(req, makeReply(401), null);
    span.end();

    const attrs = findFinished(traceId).attributes;
    const raw = attrs[FIRST_TREE_HUB_ATTR.HTTP_REQUEST_BODY];
    expect(typeof raw).toBe("string");
    const decoded = JSON.parse(raw as string) as Record<string, unknown>;
    expect(decoded.username).toBe("alice");
    expect(decoded.remember).toBe(true);
    expect(decoded.password).toBe("***");
    expect(decoded.refreshToken).toBe("***");
  });

  it("does not stamp the body when statusCode < 400 (success path)", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(span, { otelRecordBody: true }, { password: "hunter2" });
    await bodyCaptureOnSendHook(req, makeReply(200), null);
    span.end();

    expect(findFinished(traceId).attributes[FIRST_TREE_HUB_ATTR.HTTP_REQUEST_BODY]).toBeUndefined();
  });

  it("does not stamp the body when the route did not opt in", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(span, undefined, { password: "hunter2" });
    await bodyCaptureOnSendHook(req, makeReply(401), null);
    span.end();

    expect(findFinished(traceId).attributes[FIRST_TREE_HUB_ATTR.HTTP_REQUEST_BODY]).toBeUndefined();
  });

  it("truncates the body attribute to ~4 KiB with a clear marker", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    // 6 KiB of harmless filler — exceeds MAX_BODY_ATTR_LEN (4 KiB).
    const padding = "a".repeat(6 * 1024);
    const req = makeRequestWith(span, { otelRecordBody: true }, { note: padding });
    await bodyCaptureOnSendHook(req, makeReply(500), null);
    span.end();

    const raw = findFinished(traceId).attributes[FIRST_TREE_HUB_ATTR.HTTP_REQUEST_BODY] as string;
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(4096);
    expect(raw.length).toBeLessThan(4096 + 64); // 4 KiB + a small "[truncated …]" marker
    expect(raw).toMatch(/\[truncated \d+ chars\]$/);
  });
});
