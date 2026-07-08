import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = {
  startServer: vi.fn(),
};

const loggerMocks = {
  fatal: vi.fn(),
};

const mockedModules = ["../bootstrap-server.js", "../observability/index.js"];
let exitSpy: { mockRestore(): void } | undefined;

function mockEntrypointDependencies(): void {
  vi.doMock("../bootstrap-server.js", () => ({
    startServer: bootstrapMocks.startServer,
  }));
  vi.doMock("../observability/index.js", () => ({
    createLogger: vi.fn(() => loggerMocks),
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockEntrypointDependencies();
});

afterEach(() => {
  exitSpy?.mockRestore();
  exitSpy = undefined;
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

describe("server entrypoint", () => {
  it("starts the server when the entry module loads", async () => {
    bootstrapMocks.startServer.mockResolvedValueOnce(undefined);

    await import("../index.js");

    expect(bootstrapMocks.startServer).toHaveBeenCalledTimes(1);
    expect(loggerMocks.fatal).not.toHaveBeenCalled();
  });

  it("logs and exits when bootstrap rejects", async () => {
    const err = new Error("boot failed");
    bootstrapMocks.startServer.mockRejectedValueOnce(err);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("../index.js");

    await vi.waitFor(() => {
      expect(loggerMocks.fatal).toHaveBeenCalledWith({ err }, "failed to start server");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
