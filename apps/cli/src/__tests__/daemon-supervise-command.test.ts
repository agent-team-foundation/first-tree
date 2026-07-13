import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  print: {
    line: vi.fn(),
  },
}));

const supervisorMocks = vi.hoisted(() => ({
  runWindowsSupervisorLoop: vi.fn(),
}));

vi.mock("../core/output.js", () => outputMocks);
vi.mock("../core/supervisor/windows-supervisor.js", () => supervisorMocks);

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

async function runSuperviseCommand(): Promise<void> {
  const { registerDaemonSuperviseCommand } = await import("../commands/daemon/supervise.js");
  const daemon = new Command();
  registerDaemonSuperviseCommand(daemon);
  await daemon.parseAsync(["supervise"], { from: "user" });
}

describe("daemon supervise command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
      throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
    });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("rejects non-Windows platforms before starting the supervisor loop", async () => {
    setPlatform("linux");

    await expect(runSuperviseCommand()).rejects.toMatchObject({ exitCode: 1 });

    expect(supervisorMocks.runWindowsSupervisorLoop).not.toHaveBeenCalled();
    expect(outputMocks.print.line).toHaveBeenCalledWith(expect.stringContaining("only supported on win32"));
  });

  it("attempts to exit with the Windows supervisor loop result code", async () => {
    setPlatform("win32");
    supervisorMocks.runWindowsSupervisorLoop.mockResolvedValueOnce(75);

    await expect(runSuperviseCommand()).rejects.toMatchObject({ exitCode: 1 });

    expect(supervisorMocks.runWindowsSupervisorLoop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenNthCalledWith(1, 75);
  });

  it("prints Error failures from the Windows supervisor loop", async () => {
    setPlatform("win32");
    supervisorMocks.runWindowsSupervisorLoop.mockRejectedValueOnce(new Error("child spawn failed"));

    await expect(runSuperviseCommand()).rejects.toMatchObject({ exitCode: 1 });

    expect(outputMocks.print.line).toHaveBeenCalledWith(expect.stringContaining("child spawn failed"));
  });

  it("stringifies non-Error supervisor loop failures", async () => {
    setPlatform("win32");
    supervisorMocks.runWindowsSupervisorLoop.mockRejectedValueOnce("string failure");

    await expect(runSuperviseCommand()).rejects.toMatchObject({ exitCode: 1 });

    expect(outputMocks.print.line).toHaveBeenCalledWith(expect.stringContaining("string failure"));
  });
});
