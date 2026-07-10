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

function out(stdout: string): ShellOutResult {
  return { ok: true, stdout };
}

function outFail(stderr: string, code = 1): ShellOutResult {
  return { ok: false, stderr, code };
}

function marker(pid: number, createdAt = "2026-01-01T00:00:05.000Z"): string {
  return JSON.stringify({
    version: 1,
    pid,
    clientId: "client-1",
    home: "C:\\FirstTree",
    mode: "service",
    createdAt,
  });
}

function processJson(pid: number, commandLine: string, creationTimeUtc = "2026-01-01T00:00:01.000Z"): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: "100",
    Name: "node.exe",
    CommandLine: commandLine,
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CreationTimeUtc: creationTimeUtc,
  });
}

function supervisorJson(pid: number): string {
  return JSON.stringify({
    ProcessId: String(pid),
    ParentProcessId: 100,
    Name: "wscript.exe",
    CommandLine: '"C:\\FirstTree\\service\\first-tree-dev-supervisor.vbs"',
    ExecutablePath: "C:\\Windows\\System32\\wscript.exe",
    CreationTimeUtc: "2026-01-01T00:00:01.000Z",
  });
}

async function backend(): Promise<typeof import("../core/supervisor/task-scheduler.js").taskSchedulerBackend> {
  const { taskSchedulerBackend } = await import("../core/supervisor/task-scheduler.js");
  return taskSchedulerBackend;
}

function queuePowershell(taskResults: readonly ShellOutResult[], processResults: readonly ShellOutResult[] = []): void {
  const tasks = [...taskResults];
  const processes = [...processResults];
  sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
    const script = String(args.at(-1) ?? "");
    if (script.includes("Get-ScheduledTask")) return tasks.shift() ?? out("Ready");
    if (script.includes("ProcessId = 4242"))
      return processes.shift() ?? out(processJson(4242, "first-tree-dev daemon start --no-interactive"));
    if (script.includes("Get-CimInstance Win32_Process | Where-Object")) return out("");
    throw new Error(`unexpected powershell script: ${script}`);
  });
}

function setRuntimeMarkers(...bodies: string[]): void {
  fsMocks.existsSync.mockReturnValue(true);
  fsMocks.readdirSync.mockReturnValue(bodies.map((_, index) => `runtime-${index}.json`));
  fsMocks.readFileSync.mockImplementation((path) => {
    const match = String(path).match(/runtime-(\d+)\.json$/u);
    return bodies[Number(match?.[1] ?? 0)] ?? "";
  });
}

describe("task scheduler edge paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.readFileSync.mockReturnValue("");
    sharedMocks.runCapture.mockReturnValue(ok());
    queuePowershell([out("Ready")]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("falls back from PowerShell task query errors to schtasks missing and unknown states", async () => {
    sharedMocks.runCapture
      .mockReturnValueOnce(fail("cannot find the file", 1))
      .mockReturnValueOnce(fail("access denied", 5));
    queuePowershell([outFail("powershell failed", 5), outFail("powershell failed", 5)]);
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({ state: "not-installed" });
    expect(taskScheduler.status()).toMatchObject({ state: "unknown", detail: "powershell failed\naccess denied" });
  });

  it("reports unreadable runtime marker directories and files", async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockImplementation(() => {
      throw new Error("permission denied");
    });
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "Unable to inspect runtime markers: permission denied",
    });

    fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error("bad json");
    });
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("Unable to read runtime marker"),
    });
  });

  it("removes dead runtime markers while computing inactive status", async () => {
    setRuntimeMarkers(marker(4242));
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({ state: "inactive", detail: "task state Ready" });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(expect.stringContaining("runtime-0.json"), { force: true });
  });

  it("reports inconsistent task and runtime marker status combinations", async () => {
    setRuntimeMarkers(marker(4242), marker(4343));
    queuePowershell([outFail("", 3), out("Running"), out("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "task missing but service runtime marker is live",
    });
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "task running with 2 live service markers",
    });
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "task not running but service runtime marker is live",
    });
  });

  it("refuses start while a residual supervisor process is live", async () => {
    sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
      const script = String(args.at(-1) ?? "");
      if (script.includes("Get-ScheduledTask")) return out("Ready");
      if (script.includes("Get-CimInstance Win32_Process | Where-Object")) return out(supervisorJson(777));
      throw new Error(`unexpected powershell script: ${script}`);
    });
    const taskScheduler = await backend();

    expect(taskScheduler.start()).toEqual({
      ok: false,
      reason: "supervisor process is live without a running task; run daemon stop and wait before starting again",
    });
  });

  it("refuses stop when marker trust checks detect pid reuse or malformed process data", async () => {
    setRuntimeMarkers(marker(4242, "not-a-date"));
    queuePowershell([out("Running")], [out(processJson(4242, "first-tree-dev daemon start --no-interactive"))]);
    const taskScheduler = await backend();
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason:
        "refusing to taskkill untrusted service runtime marker pid 4242: runtime marker has invalid createdAt not-a-date",
    });

    setRuntimeMarkers(marker(4242));
    queuePowershell([out("Running")], [out(processJson(4242, "notepad.exe"))]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringContaining("pid command does not match First Tree daemon start"),
    });

    queuePowershell([out("Running")], [out("{")]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: "refusing to taskkill untrusted service runtime marker pid 4242: process query returned malformed JSON",
    });
  });
});
