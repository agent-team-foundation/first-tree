import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detectInstallModeMock = vi.fn<() => "source" | "npx" | "global">();
const fetchLatestVersionMock = vi.fn();
const getClientServiceStatusMock = vi.fn();
const installClientServiceMock = vi.fn();
const installGlobalLatestMock = vi.fn();
const isServiceSupportedMock = vi.fn<() => boolean>();
const printLineMock = vi.fn();
const restartClientServiceMock = vi.fn();

async function loadCommand(): Promise<Command> {
  vi.doMock("../core/index.js", () => ({
    COMMAND_VERSION: "1.0.0",
    PACKAGE_NAME: "first-tree",
    detectInstallMode: detectInstallModeMock,
    fetchLatestVersion: fetchLatestVersionMock,
    getClientServiceStatus: getClientServiceStatusMock,
    installClientService: installClientServiceMock,
    installGlobalLatest: installGlobalLatestMock,
    isServiceSupported: isServiceSupportedMock,
    restartClientService: restartClientServiceMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));

  const { registerUpgradeCommand } = await import("../commands/upgrade.js");
  const program = new Command();
  program.exitOverride();
  registerUpgradeCommand(program);
  return program;
}

describe("upgrade command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    detectInstallModeMock.mockReturnValue("global");
    fetchLatestVersionMock.mockReturnValue({ ok: true, version: "1.2.0" });
    getClientServiceStatusMock.mockReturnValue({ state: "active" });
    installClientServiceMock.mockReturnValue(undefined);
    installGlobalLatestMock.mockResolvedValue({ ok: true, installedVersion: "1.2.0" });
    isServiceSupportedMock.mockReturnValue(true);
    restartClientServiceMock.mockReturnValue({ ok: true });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op for source checkouts and npx launches", async () => {
    const program = await loadCommand();

    detectInstallModeMock.mockReturnValueOnce("source");
    await program.parseAsync(["upgrade"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("source checkout");
    expect(fetchLatestVersionMock).not.toHaveBeenCalled();

    printLineMock.mockClear();
    detectInstallModeMock.mockReturnValueOnce("npx");
    await program.parseAsync(["upgrade"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("cannot self-upgrade");
  });

  it("reports registry failures, up-to-date installs, and check-only upgrades", async () => {
    const program = await loadCommand();

    fetchLatestVersionMock.mockReturnValueOnce({ ok: false, reason: "npm offline" });
    await expect(program.parseAsync(["upgrade"], { from: "user" })).rejects.toThrow("exit:1");
    expect(printLineMock.mock.calls.flat().join("")).toContain("npm offline");

    printLineMock.mockClear();
    fetchLatestVersionMock.mockReturnValueOnce({ ok: true, version: "1.0.0" });
    await program.parseAsync(["upgrade"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Already on 1.0.0");

    printLineMock.mockClear();
    fetchLatestVersionMock.mockReturnValueOnce({ ok: true, version: "1.2.0" });
    await program.parseAsync(["upgrade", "--check"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Upgrade available: 1.0.0");
    expect(installGlobalLatestMock).not.toHaveBeenCalled();
  });

  it("handles install failure and no-restart staging", async () => {
    const program = await loadCommand();

    installGlobalLatestMock.mockResolvedValueOnce({ ok: false, reason: "permission denied" });
    await expect(program.parseAsync(["upgrade"], { from: "user" })).rejects.toThrow("exit:1");
    expect(printLineMock.mock.calls.flat().join("")).toContain("Install failed: permission denied");

    printLineMock.mockClear();
    installGlobalLatestMock.mockResolvedValueOnce({ ok: true, installedVersion: undefined });
    await program.parseAsync(["upgrade", "--no-restart"], { from: "user" });
    const printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("Installed 1.2.0");
    expect(printed).toContain("Skipping restart");
    expect(restartClientServiceMock).not.toHaveBeenCalled();
  });

  it("prints service-state outcomes without restarting when restart is not applicable", async () => {
    const program = await loadCommand();

    isServiceSupportedMock.mockReturnValueOnce(false);
    await program.parseAsync(["upgrade"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("No service manager");

    printLineMock.mockClear();
    getClientServiceStatusMock.mockReturnValueOnce({ state: "not-installed" });
    await program.parseAsync(["upgrade"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("No background service installed");

    printLineMock.mockClear();
    getClientServiceStatusMock.mockReturnValueOnce({ state: "inactive" });
    await program.parseAsync(["upgrade"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Service is stopped");
  });

  it("refreshes the unit file, warns on refresh failure, and reports restart failure or success", async () => {
    const program = await loadCommand();

    installClientServiceMock.mockImplementationOnce(() => {
      throw new Error("unit denied");
    });
    restartClientServiceMock.mockReturnValueOnce({ ok: false, reason: "restart denied" });
    await expect(program.parseAsync(["upgrade"], { from: "user" })).rejects.toThrow("exit:1");
    let printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("unit-file refresh failed: unit denied");
    expect(printed).toContain("Service restart failed: restart denied");

    printLineMock.mockClear();
    restartClientServiceMock.mockReturnValueOnce({ ok: true });
    await program.parseAsync(["upgrade"], { from: "user" });
    printed = printLineMock.mock.calls.flat().join("");
    expect(installClientServiceMock).toHaveBeenCalled();
    expect(printed).toContain("Service restarted on 1.2.0");
  });
});
