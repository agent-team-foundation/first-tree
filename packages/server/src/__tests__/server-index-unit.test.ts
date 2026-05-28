import { beforeEach, describe, expect, it, vi } from "vitest";

const applyLoggerConfigMock = vi.fn();
const buildAppMock = vi.fn();
const closeMock = vi.fn();
const createLoggerMock = vi.fn();
const initConfigMock = vi.fn();
const initTelemetryMock = vi.fn();
const listenMock = vi.fn();
const markReadyMock = vi.fn();
const runMigrationsMock = vi.fn();
const runStageMock = vi.fn();
const shutdownTelemetryMock = vi.fn();

function serverConfig(): Record<string, unknown> {
  return {
    auth: {
      accessTokenExpiry: "15m",
      connectTokenExpiry: "10m",
      refreshTokenExpiry: "30d",
    },
    database: { url: "postgres://db" },
    inbox: {},
    observability: {
      logging: { bridgeToSpanLevel: "warn", format: "pretty", level: "debug" },
      tracing: { enabled: false },
    },
    secrets: { jwtSecret: "secret" },
    server: { host: "127.0.0.1", port: 8000 },
  };
}

function setupIndexMocks(): void {
  vi.doMock("node:crypto", () => ({ randomUUID: () => "12345678-aaaa-bbbb-cccc-123456789012" }));
  vi.doMock("@first-tree/shared/config", () => ({
    initConfig: initConfigMock,
    serverConfigSchema: {},
  }));
  vi.doMock("../app.js", () => ({ buildApp: buildAppMock }));
  vi.doMock("../bootstrap-state.js", () => ({ markReady: markReadyMock }));
  vi.doMock("../bootstrap-utils.js", () => ({ runStage: runStageMock }));
  vi.doMock("../db/migrate.js", () => ({ runMigrations: runMigrationsMock }));
  vi.doMock("../observability/index.js", () => ({
    applyLoggerConfig: applyLoggerConfigMock,
    createLogger: createLoggerMock,
    initTelemetry: initTelemetryMock,
    shutdownTelemetry: shutdownTelemetryMock,
  }));
}

describe("server index bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.FIRST_TREE_WEB_DIST_PATH;
    createLoggerMock.mockReturnValue({ fatal: vi.fn(), info: vi.fn() });
    initConfigMock.mockResolvedValue(serverConfig());
    buildAppMock.mockResolvedValue({ close: closeMock, listen: listenMock });
    closeMock.mockResolvedValue(undefined);
    listenMock.mockResolvedValue(undefined);
    runMigrationsMock.mockResolvedValue(12);
    runStageMock.mockImplementation(async (_name: string, fn: () => Promise<unknown> | unknown) => fn());
    shutdownTelemetryMock.mockResolvedValue(undefined);
    setupIndexMocks();
  });

  it("boots the server through staged telemetry, migrations, app build, listen, and readiness", async () => {
    process.env.FIRST_TREE_WEB_DIST_PATH = "/srv/web";

    await import("../index.js");
    await vi.waitFor(() => expect(markReadyMock).toHaveBeenCalled());

    expect(applyLoggerConfigMock).toHaveBeenCalledWith({
      bridgeToSpanLevel: "warn",
      format: "pretty",
      level: "debug",
    });
    expect(runStageMock).toHaveBeenCalledWith("initTelemetry", expect.any(Function), 10_000);
    expect(initTelemetryMock).toHaveBeenCalledWith({ enabled: false }, "srv_12345678");
    expect(runMigrationsMock).toHaveBeenCalledWith("postgres://db");
    expect(buildAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "srv_12345678", webDistPath: "/srv/web" }),
    );
    expect(listenMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8000 });
  });

  it("logs and exits when bootstrap fails", async () => {
    const fatalMock = vi.fn();
    createLoggerMock.mockReturnValue({ fatal: fatalMock, info: vi.fn() });
    initConfigMock.mockRejectedValue(new Error("config failed"));
    const exitMock = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as (code?: number | string | null) => never);

    await import("../index.js");
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledWith(1));

    expect(fatalMock).toHaveBeenCalledWith({ err: expect.any(Error) }, "failed to start server");
    exitMock.mockRestore();
  });
});
