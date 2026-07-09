import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logfireMocks = {
  configure: vi.fn(),
  shutdown: vi.fn(),
};

const loggerMocks = {
  info: vi.fn(),
  warn: vi.fn(),
};

const bridgeMocks = {
  installPinoErrorBridge: vi.fn(),
  uninstallPinoErrorBridge: vi.fn(),
};

const mockedModules = ["@pydantic/logfire-node", "../logger.js", "../otel-helpers.js"];

function mockLogfireDependencies(): void {
  vi.doMock("@pydantic/logfire-node", () => logfireMocks);
  vi.doMock("../logger.js", () => ({
    createLogger: vi.fn(() => loggerMocks),
  }));
  vi.doMock("../otel-helpers.js", () => ({
    installPinoErrorBridge: bridgeMocks.installPinoErrorBridge,
    uninstallPinoErrorBridge: bridgeMocks.uninstallPinoErrorBridge,
  }));
}

const tracingConfig = {
  endpoint: "https://logfire-us.pydantic.dev/v1/traces",
  environment: "test",
  exporter: "otlp-grpc" as const,
  headers: "Authorization=Bearer pylf_v1_us_token,Other=value",
  sampleRate: 0.5,
  serviceName: "first-tree-test",
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockLogfireDependencies();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

describe("Logfire telemetry lifecycle", () => {
  it("configures Logfire with token, base URL, sampling, scrubbing, and instance resource attrs", async () => {
    const { initTelemetry, isTelemetryEnabled } = await import("../logfire-init.js");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=test");

    await initTelemetry(tracingConfig, "srv_1");

    expect(logfireMocks.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        advanced: { baseUrl: "https://logfire-us.pydantic.dev" },
        environment: "test",
        metrics: false,
        sampling: { head: 0.5 },
        serviceName: "first-tree-test",
        serviceVersion: "0.1.0",
        token: "pylf_v1_us_token",
      }),
    );
    expect(logfireMocks.configure.mock.calls[0]?.[0].nodeAutoInstrumentations).toMatchObject({
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-http": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    });
    expect(logfireMocks.configure.mock.calls[0]?.[0].scrubbing.extraPatterns.length).toBeGreaterThan(0);
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe("deployment.environment=test,service.instance.id=srv_1");
    expect(process.env.__FIRST_TREE_OTEL_RESOURCE_ATTRIBUTES_BASE).toBe("deployment.environment=test");
    expect(bridgeMocks.installPinoErrorBridge).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "otlp-grpc exporter requested but Logfire SDK is HTTP-only; falling back to otlp-http",
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "tracing enabled: endpoint=logfire-us.pydantic.dev service=first-tree-test env=test instance=srv_1 sampleRate=0.5",
    );
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("reinitializes an enabled SDK without accumulating resource attributes", async () => {
    const { initTelemetry, shutdownTelemetry } = await import("../logfire-init.js");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=test");

    await initTelemetry({ ...tracingConfig, exporter: "otlp-http" }, "srv_1");
    await initTelemetry({ ...tracingConfig, exporter: "otlp-http" }, "srv_2");

    expect(loggerMocks.warn).toHaveBeenCalledWith("initTelemetry called twice; shutting down previous Logfire SDK");
    expect(logfireMocks.shutdown).toHaveBeenCalledTimes(1);
    expect(logfireMocks.configure).toHaveBeenCalledTimes(2);
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe("deployment.environment=test,service.instance.id=srv_2");

    await shutdownTelemetry();
  });

  it("uninstalls the pino bridge and swallows Logfire shutdown errors", async () => {
    const { initTelemetry, isTelemetryEnabled, shutdownTelemetry } = await import("../logfire-init.js");
    logfireMocks.shutdown.mockRejectedValueOnce(new Error("flush failed"));

    await initTelemetry({ ...tracingConfig, exporter: "otlp-http" }, "srv_1");
    await expect(shutdownTelemetry()).resolves.toBeUndefined();

    expect(bridgeMocks.uninstallPinoErrorBridge).toHaveBeenCalledTimes(1);
    expect(isTelemetryEnabled()).toBe(false);
  });
});
