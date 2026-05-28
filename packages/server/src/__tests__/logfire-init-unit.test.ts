import { beforeEach, describe, expect, it, vi } from "vitest";

const configureMock = vi.fn();
const infoMock = vi.fn();
const installBridgeMock = vi.fn();
const shutdownMock = vi.fn();
const uninstallBridgeMock = vi.fn();
const warnMock = vi.fn();

async function loadTelemetryModule(): Promise<typeof import("../observability/logfire-init.js")> {
  vi.doMock("@pydantic/logfire-node", () => ({
    configure: configureMock,
    shutdown: shutdownMock,
  }));
  vi.doMock("../observability/logger.js", () => ({
    createLogger: () => ({ info: infoMock, warn: warnMock }),
  }));
  vi.doMock("../observability/otel-helpers.js", () => ({
    installPinoErrorBridge: installBridgeMock,
    uninstallPinoErrorBridge: uninstallBridgeMock,
  }));
  return import("../observability/logfire-init.js");
}

describe("logfire telemetry bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.__FIRST_TREE_OTEL_RESOURCE_ATTRIBUTES_BASE;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  it("parses comma-separated OTLP headers and preserves values containing equals", async () => {
    const { parseHeaderString } = await loadTelemetryModule();

    expect(parseHeaderString("")).toEqual({});
    expect(parseHeaderString("Authorization=Bearer pylf_v1_us_token, x-trace = a=b=c, broken")).toEqual({
      Authorization: "Bearer pylf_v1_us_token",
      "x-trace": "a=b=c",
    });
  });

  it("stays disabled when tracing config or bearer token is missing", async () => {
    const { initTelemetry, isTelemetryEnabled } = await loadTelemetryModule();

    await initTelemetry(undefined, "srv_1");
    await initTelemetry(
      {
        endpoint: "https://logfire-us.pydantic.dev/v1/traces",
        environment: "test",
        exporter: "otlp-grpc",
        headers: "x-api-key=nope",
        sampleRate: 1,
        serviceName: "first-tree-test",
      },
      "srv_2",
    );

    expect(isTelemetryEnabled()).toBe(false);
    expect(configureMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("otlp-grpc exporter requested"));
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("no bearer token"));
  });

  it("configures Logfire, snapshots resource attributes, reinitializes, and shuts down", async () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=test";
    const { initTelemetry, isTelemetryEnabled, shutdownTelemetry } = await loadTelemetryModule();
    const config: NonNullable<Parameters<typeof initTelemetry>[0]> = {
      endpoint: "https://logfire-us.pydantic.dev/v1/traces",
      environment: "test",
      exporter: "otlp-http",
      headers: "Authorization=Bearer pylf_v1_us_token",
      sampleRate: 0.5,
      serviceName: "first-tree-test",
    };

    await initTelemetry(config, "srv_a");
    await initTelemetry({ ...config, endpoint: "not a url", headers: "authorization=Bearer token_two" }, "srv_b");
    await shutdownTelemetry();

    expect(configureMock).toHaveBeenCalledTimes(2);
    expect(configureMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        environment: "test",
        metrics: false,
        serviceName: "first-tree-test",
        token: "pylf_v1_us_token",
      }),
    );
    expect(configureMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        advanced: { baseUrl: undefined },
        token: "token_two",
      }),
    );
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe("deployment.environment=test,service.instance.id=srv_b");
    expect(shutdownMock).toHaveBeenCalledTimes(2);
    expect(installBridgeMock).toHaveBeenCalledTimes(2);
    expect(uninstallBridgeMock).toHaveBeenCalledTimes(1);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("does not block shutdown when Logfire flushing fails", async () => {
    const { initTelemetry, isTelemetryEnabled, shutdownTelemetry } = await loadTelemetryModule();
    shutdownMock.mockRejectedValueOnce(new Error("flush failed"));

    await initTelemetry({
      endpoint: "https://self-hosted.example.test/v1/traces",
      environment: "test",
      exporter: "otlp-http",
      headers: "Authorization=Bearer token",
      sampleRate: 1,
      serviceName: "first-tree-test",
    });
    await shutdownTelemetry();

    expect(isTelemetryEnabled()).toBe(false);
    expect(uninstallBridgeMock).toHaveBeenCalled();
  });
});
