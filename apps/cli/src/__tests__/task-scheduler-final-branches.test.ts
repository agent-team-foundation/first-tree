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

function taskMissing(): ShellOutResult {
  return { ok: false, stderr: "", code: 3 };
}

function markerJson(pid: number): string {
  return JSON.stringify({
    version: 1,
    pid,
    clientId: "client-1",
    home: "C:\\FirstTree",
    mode: "service",
    createdAt: "2026-01-01T00:00:05.000Z",
  });
}

function processJson(pid: number, commandLine = "first-tree-dev daemon start --no-interactive"): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 100,
    Name: "node.exe",
    CommandLine: commandLine,
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CreationTimeUtc: "2026-01-01T00:00:01.000Z",
  });
}

function supervisorJson(pid: number): string {
  return JSON.stringify({
    ProcessId: pid,
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

function setMarkerFile(body: string): void {
  fsMocks.existsSync.mockReturnValue(true);
  fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
  fsMocks.readFileSync.mockReturnValue(body);
}

function queuePowershell(
  taskResults: readonly ShellOutResult[],
  processResults: readonly ShellOutResult[] = [],
  supervisorResults: readonly ShellOutResult[] = [out("")],
): void {
  const tasks = [...taskResults];
  const processes = [...processResults];
  const supervisors = [...supervisorResults];
  sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
    const script = String(args.at(-1) ?? "");
    if (script.includes("Get-ScheduledTask")) return tasks.shift() ?? out("Ready");
    if (script.includes("ProcessId = 4242")) return processes.shift() ?? out(processJson(4242));
    if (script.includes("Get-CimInstance Win32_Process | Where-Object")) return supervisors.shift() ?? out("");
    throw new Error(`unexpected powershell script: ${script}`);
  });
}

describe("task scheduler final branch coverage", () => {
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

  it("returns marker read failures from stop", async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error("cannot read marker");
    });
    queuePowershell([out("Running")]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringContaining("Unable to read runtime marker"),
    });
  });

  it("reports missing task with residual supervisor process and malformed supervisor JSON", async () => {
    queuePowershell([taskMissing(), taskMissing()], [], [out(supervisorJson(777)), out("{")]);
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "task missing but supervisor process is still live",
    });
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "supervisor process query returned malformed JSON",
    });
  });

  it("reports supervisor query failures during start and cleanup verification", async () => {
    queuePowershell(
      [out("Ready"), taskMissing()],
      [],
      [outFail("query denied", 5), out(supervisorJson(777)), outFail("gone", 9)],
    );
    const taskScheduler = await backend();

    expect(taskScheduler.start()).toEqual({ ok: false, reason: "query denied" });
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: "unable to verify supervisor process cleanup: gone",
    });
  });

  it("reports end task failures while preserving not-running as a successful end", async () => {
    queuePowershell([out("Running"), out("Ready"), out("Running")]);
    sharedMocks.runCapture
      .mockReturnValueOnce(fail("not currently running", 1))
      .mockReturnValueOnce(fail("access denied", 5));
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: true,
      detail: "task ended without a runtime marker; check Task Manager for any residual first-tree process",
    });
    expect(taskScheduler.stop()).toEqual({ ok: false, reason: "access denied" });
  });

  it("reports untrusted marker pids discovered during the kill phase", async () => {
    setMarkerFile(markerJson(4242));
    queuePowershell([out("Running")], [out(processJson(4242)), out(processJson(4242, "notepad.exe"))]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringContaining("refusing to taskkill untrusted service runtime marker pid 4242"),
    });
  });

  it("reports when a forced taskkill succeeds but the pid stays alive", async () => {
    setMarkerFile(markerJson(4242));
    const times = [0, 6000, 12_000, 18_000];
    vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? 18_000);
    queuePowershell([out("Running")], [out(processJson(4242)), out(processJson(4242))]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: "pid 4242 did not exit after taskkill /F",
    });
  });
});
