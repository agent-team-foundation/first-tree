import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  ensureLogDir: vi.fn(),
  readFileOrFlagDrift: vi.fn(),
  resolveCliInvocation: vi.fn(() => ({ kind: "bin", program: "first-tree-dev" })),
  runCapture: vi.fn(),
  runCaptureOut: vi.fn(),
  sleepSync: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  defaultHome: vi.fn(() => "C:\\FirstTree"),
}));

type ShellResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly stderr: string; readonly code: number | null };
type ShellOutResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly stderr: string; readonly code: number | null };

vi.mock("node:fs", () => fsMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/supervisor/shared.js", () => sharedMocks);

function ok(): ShellResult {
  return { ok: true };
}

function fail(stderr: string, code = 1): ShellResult {
  return { ok: false, stderr, code };
}

function taskState(stdout: string): ShellOutResult {
  return { ok: true, stdout };
}

function taskMissing(): ShellOutResult {
  return { ok: false, stderr: "task not found", code: 3 };
}

function supervisorProcesses(stdout = ""): ShellOutResult {
  return { ok: true, stdout };
}

function runtimeMarker(pid: number): string {
  return JSON.stringify({
    version: 1,
    pid,
    clientId: "client-1",
    home: "C:\\FirstTree",
    mode: "service",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function supervisorProcess(pid: number): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 100,
    Name: "wscript.exe",
    CommandLine: '"C:\\FirstTree\\service\\first-tree-dev-supervisor.vbs"',
    ExecutablePath: "C:\\Windows\\System32\\wscript.exe",
    CreationTimeUtc: "2026-01-01T00:00:00.000Z",
  });
}

async function backend(): Promise<typeof import("../core/supervisor/task-scheduler.js").taskSchedulerBackend> {
  const { taskSchedulerBackend } = await import("../core/supervisor/task-scheduler.js");
  return taskSchedulerBackend;
}

function queueTaskQueries(results: readonly ShellOutResult[]): void {
  const queue = [...results];
  sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
    const script = String(args.at(-1) ?? "");
    if (script.includes("Get-ScheduledTask")) return queue.shift() ?? taskState("Ready");
    if (script.includes("Get-CimInstance Win32_Process | Where-Object")) return supervisorProcesses();
    throw new Error(`unexpected powershell script: ${script}`);
  });
}

describe("task scheduler service operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.readFileSync.mockReturnValue("");
    sharedMocks.runCapture.mockReturnValue(ok());
    queueTaskQueries([taskState("Ready")]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("installs supervisor files, registers the task, and requests a run", async () => {
    const taskScheduler = await backend();

    const info = taskScheduler.install();

    expect(info).toMatchObject({
      platform: "task-scheduler",
      state: "active",
      detail: "task run requested",
    });
    expect(sharedMocks.ensureLogDir).toHaveBeenCalledTimes(1);
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(3);
    expect(sharedMocks.runCapture).toHaveBeenCalledWith(
      "schtasks.exe",
      expect.arrayContaining(["/Create", "/F"]),
      10_000,
    );
    expect(sharedMocks.runCapture).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining(["/Run"]), 10_000);
  });

  it("rejects start when the task is missing", async () => {
    queueTaskQueries([taskMissing()]);
    const taskScheduler = await backend();

    expect(taskScheduler.start()).toEqual({ ok: false, reason: "service not installed" });
  });

  it("starts a registered task after proving no runtime or supervisor process is live", async () => {
    queueTaskQueries([taskState("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.start()).toEqual({ ok: true });
    expect(sharedMocks.runCapture).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining(["/Run"]), 10_000);
  });

  it("stops a running task without a marker and returns the residual-process warning", async () => {
    queueTaskQueries([taskState("Running"), taskState("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: true,
      detail: "task ended without a runtime marker; check Task Manager for any residual first-tree process",
    });
    expect(sharedMocks.runCapture).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining(["/End"]), 10_000);
  });

  it("refuses stop when a live runtime marker cannot be trusted", async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
    fsMocks.readFileSync.mockReturnValue(runtimeMarker(4242));
    sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
      const script = String(args.at(-1) ?? "");
      if (script.includes("Get-ScheduledTask")) return taskState("Running");
      if (script.includes("ProcessId = 4242")) return { ok: false, stderr: "access denied", code: 5 };
      throw new Error(`unexpected powershell script: ${script}`);
    });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: "refusing to taskkill untrusted service runtime marker pid 4242: access denied",
    });
  });

  it("uninstalls task artifacts and preserves a stop warning as status detail", async () => {
    queueTaskQueries([{ ok: false, stderr: "state query failed", code: 5 }]);
    const taskScheduler = await backend();

    expect(taskScheduler.uninstall()).toMatchObject({
      state: "not-installed",
      detail: "state query failed",
    });
    expect(sharedMocks.runCapture).toHaveBeenCalledWith(
      "schtasks.exe",
      expect.arrayContaining(["/Delete", "/F"]),
      10_000,
    );
    expect(fsMocks.rmSync).toHaveBeenCalledWith(expect.stringContaining("supervisor.cmd"), { force: true });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(expect.stringContaining("supervisor.vbs"), { force: true });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(expect.stringContaining("task.xml"), { force: true });
  });

  it("throws when deleting the task fails with a native Windows error", async () => {
    queueTaskQueries([taskMissing()]);
    sharedMocks.runCapture.mockImplementation((_program, args) =>
      args.includes("/Delete") ? fail("localized failure", 87) : ok(),
    );
    const taskScheduler = await backend();

    expect(() => taskScheduler.uninstall()).toThrow("schtasks /Delete failed: localized failure");
  });

  it("reports residual supervisor cleanup timeouts after a missing task stop", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(71_000);
    queueTaskQueries([taskMissing()]);
    sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
      const script = String(args.at(-1) ?? "");
      if (script.includes("Get-ScheduledTask")) return taskMissing();
      if (script.includes("Get-CimInstance Win32_Process | Where-Object")) {
        return supervisorProcesses(supervisorProcess(777));
      }
      throw new Error(`unexpected powershell script: ${script}`);
    });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringContaining("supervisor process still running after task end"),
    });
  });
});
