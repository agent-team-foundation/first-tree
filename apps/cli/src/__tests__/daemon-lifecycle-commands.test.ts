import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn();
const getClientServiceStatusMock = vi.fn();
const isServiceSupportedMock = vi.fn();
const printLineMock = vi.fn();
const restartClientServiceMock = vi.fn();
const stopClientServiceMock = vi.fn();
const unlinkSyncMock = vi.fn();

function setupMocks(): void {
  vi.doMock("node:fs", () => ({
    existsSync: existsSyncMock,
    unlinkSync: unlinkSyncMock,
  }));
  vi.doMock("@first-tree/shared/config", () => ({
    defaultConfigDir: () => "/tmp/first-tree-config",
  }));
  vi.doMock("../core/index.js", () => ({
    getClientServiceStatus: getClientServiceStatusMock,
    isServiceSupported: isServiceSupportedMock,
    restartClientService: restartClientServiceMock,
    stopClientService: stopClientServiceMock,
  }));
  vi.doMock("../core/output.js", () => ({ print: { line: printLineMock } }));
}

async function daemonProgram(): Promise<Command> {
  setupMocks();
  const { registerDaemonRestartCommand } = await import("../commands/daemon/restart.js");
  const { registerDaemonStopCommand } = await import("../commands/daemon/stop.js");
  const program = new Command();
  program.exitOverride();
  registerDaemonStopCommand(program);
  registerDaemonRestartCommand(program);
  return program;
}

async function logoutProgram(): Promise<Command> {
  setupMocks();
  const { registerLogoutCommand } = await import("../commands/logout.js");
  const program = new Command();
  program.exitOverride();
  registerLogoutCommand(program);
  return program;
}

describe("daemon lifecycle commands", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    existsSyncMock.mockReset();
    getClientServiceStatusMock.mockReset();
    isServiceSupportedMock.mockReset();
    printLineMock.mockReset();
    restartClientServiceMock.mockReset();
    stopClientServiceMock.mockReset();
    unlinkSyncMock.mockReset();
  });

  it("handles daemon stop unsupported, empty, inactive, failed, and successful states", async () => {
    let program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(false);
    await program.parseAsync(["node", "first-tree", "stop"]);
    expect(stopClientServiceMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("not supported");

    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ state: "not-installed" });
    await program.parseAsync(["node", "first-tree", "stop"]);
    expect(stopClientServiceMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("nothing to stop");

    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ state: "inactive" });
    await program.parseAsync(["node", "first-tree", "stop"]);
    expect(stopClientServiceMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("already stopped");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${String(code)}`);
    });
    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ platform: "systemd", state: "active" });
    stopClientServiceMock.mockReturnValueOnce({ ok: false, reason: "permission denied" });
    await expect(program.parseAsync(["node", "first-tree", "stop"])).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("permission denied");

    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ platform: "launchd", state: "active" });
    stopClientServiceMock.mockReturnValueOnce({ ok: true });
    await program.parseAsync(["node", "first-tree", "stop"]);
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("Stopped launchd service");
  });

  it("handles daemon restart unsupported, missing, failed, and successful states", async () => {
    let program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(false);
    await program.parseAsync(["node", "first-tree", "restart"]);
    expect(restartClientServiceMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("not supported");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${String(code)}`);
    });
    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ state: "not-installed" });
    await expect(program.parseAsync(["node", "first-tree", "restart"])).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);

    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ platform: "systemd", state: "inactive" });
    restartClientServiceMock.mockReturnValueOnce({ ok: false, reason: "unit missing" });
    await expect(program.parseAsync(["node", "first-tree", "restart"])).rejects.toThrow("exit:1");
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("unit missing");

    printLineMock.mockReset();
    program = await daemonProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock
      .mockReturnValueOnce({ platform: "systemd", state: "active" })
      .mockReturnValueOnce({ detail: "pid 123", platform: "systemd", state: "active" });
    restartClientServiceMock.mockReturnValueOnce({ ok: true });
    await program.parseAsync(["node", "first-tree", "restart"]);
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("Restarted systemd service (pid 123)");
  });

  it("stops active service and removes logout credentials with optional purge", async () => {
    const program = await logoutProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ platform: "systemd", state: "active" });
    stopClientServiceMock.mockReturnValueOnce({ ok: false, reason: "already gone" });
    existsSyncMock.mockReturnValue(true);

    await program.parseAsync(["node", "first-tree", "logout", "--purge"]);

    expect(stopClientServiceMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/first-tree-config/credentials.json");
    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/first-tree-config/client.yaml");
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("warning: already gone");
    expect(printLineMock.mock.calls.flat().join("\n")).toContain("Logged out");
  });

  it("keeps client config on logout by default and skips daemon stop when inactive", async () => {
    const program = await logoutProgram();
    isServiceSupportedMock.mockReturnValueOnce(true);
    getClientServiceStatusMock.mockReturnValueOnce({ platform: "launchd", state: "inactive" });
    existsSyncMock.mockImplementation((path: unknown) => String(path).endsWith("credentials.json"));

    await program.parseAsync(["node", "first-tree", "logout"]);

    expect(stopClientServiceMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/first-tree-config/credentials.json");
  });
});
