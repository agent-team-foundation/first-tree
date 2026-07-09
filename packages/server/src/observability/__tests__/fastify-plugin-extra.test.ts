import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = {
  child: vi.fn(),
  warn: vi.fn(),
};

const traceMocks = {
  currentTraceId: vi.fn(),
};

const mockedModules = ["../logger.js", "../otel-helpers.js"];

function mockObservabilityDependencies(): void {
  vi.doMock("../logger.js", () => ({
    createLogger: vi.fn(() => ({ child: loggerMocks.child })),
  }));
  vi.doMock("../otel-helpers.js", () => ({
    currentTraceId: traceMocks.currentTraceId,
  }));
}

type HookName = "onRequest" | "onResponse";

type HookHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

function makeApp(): {
  addHook: (name: HookName, handler: HookHandler) => void;
  hooks: Partial<Record<HookName, HookHandler>>;
} {
  const hooks: Partial<Record<HookName, HookHandler>> = {};
  return {
    addHook(name: HookName, handler: HookHandler): void {
      hooks[name] = handler;
    },
    hooks,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockObservabilityDependencies();
  loggerMocks.child.mockReturnValue({ warn: loggerMocks.warn });
});

afterEach(() => {
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

describe("observabilityPlugin", () => {
  it("binds request logs to request/trace ids and stamps x-trace-id", async () => {
    const { observabilityPlugin } = await import("../fastify-plugin.js");
    const app = makeApp();
    traceMocks.currentTraceId.mockReturnValue("trace_1");
    await observabilityPlugin(app as never, {} as never);
    const headers: Record<string, string> = {};
    const request = { id: "req_1", method: "GET", url: "/healthz" } as FastifyRequest;
    const reply = {
      header(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      statusCode: 200,
    } as FastifyReply;

    await app.hooks.onRequest?.(request, reply);
    await app.hooks.onResponse?.(request, reply);

    expect(loggerMocks.child).toHaveBeenCalledWith({ requestId: "req_1", traceId: "trace_1" });
    expect(headers).toEqual({ "x-trace-id": "trace_1" });
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("omits trace metadata when absent and warns on 5xx responses", async () => {
    const { observabilityPlugin } = await import("../fastify-plugin.js");
    const app = makeApp();
    traceMocks.currentTraceId.mockReturnValue(undefined);
    await observabilityPlugin(app as never, {} as never);
    const request = {
      id: "req_2",
      log: { warn: loggerMocks.warn },
      method: "POST",
      url: "/api/fail",
    } as unknown as FastifyRequest;
    const reply = {
      header: vi.fn(),
      statusCode: 503,
    } as unknown as FastifyReply;

    await app.hooks.onRequest?.(request, reply);
    await app.hooks.onResponse?.(request, reply);

    expect(loggerMocks.child).toHaveBeenCalledWith({ requestId: "req_2" });
    expect(reply.header).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { method: "POST", statusCode: 503, url: "/api/fail" },
      "request failed",
    );
  });
});
