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

function fail(stderr: string, code: number | null = 1): ShellResult {
  return { ok: false, stderr, code };
}

function out(stdout: string): ShellOutResult {
  return { ok: true, stdout };
}

function outFail(stderr: string, code: number | null = 1): ShellOutResult {
  return { ok: false, stderr, code };
}

function taskMissing(): ShellOutResult {
  return { ok: false, stderr: "", code: 3 };
}

function markerJson(pid: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    pid,
    clientId: "client-1",
    home: "C:\\FirstTree",
    mode: "service",
    createdAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  });
}

function processJson(
  pid: number,
  commandLine = "first-tree-dev daemon start --no-interactive",
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 100,
    Name: "node.exe",
    CommandLine: commandLine,
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CreationTimeUtc: "2026-01-01T00:00:01.000Z",
    ...overrides,
  });
}

function supervisorJson(pid: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 100,
    Name: "wscript.exe",
    CommandLine: '"C:\\FirstTree\\service\\first-tree-dev-supervisor.vbs"',
    ExecutablePath: "C:\\Windows\\System32\\wscript.exe",
    CreationTimeUtc: "2026-01-01T00:00:01.000Z",
    ...overrides,
  });
}

function throwUnknown(value: unknown): never {
  throw value;
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
    vi.unstubAllEnvs();
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

  it("renders the task XML from explicit Windows identity and system-root environment", async () => {
    vi.stubEnv("USERDOMAIN", "ACME");
    vi.stubEnv("USERNAME", "alice");
    vi.stubEnv("SystemRoot", "C:\\Windows\\");
    const { renderWindowsTaskXml } = await import("../core/supervisor/task-scheduler.js");

    const xml = renderWindowsTaskXml("C:\\FirstTree\\service\\supervisor.vbs");

    expect(xml).toContain("<Author>ACME\\alice</Author>");
    expect(xml).toContain("<Command>C:\\Windows\\System32\\wscript.exe</Command>");
  });

  it("reports an unknown native exit when task installation cannot request a run", async () => {
    sharedMocks.runCapture.mockImplementation((_program, args) => (args.includes("/Run") ? fail("", null) : ok()));
    const taskScheduler = await backend();

    expect(() => taskScheduler.install()).toThrow("schtasks /Run failed: exit unknown");
  });

  it("detects drift when the task XML is readable without a byte-order mark", async () => {
    fsMocks.readFileSync.mockReturnValue("plain xml");
    sharedMocks.readFileOrFlagDrift.mockReturnValue(false);
    queuePowershell([out("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.isUnitDriftDetected()).toBe(true);
  });

  it("covers empty task states and native query fallback details", async () => {
    const taskScheduler = await backend();

    queuePowershell([out("")]);
    expect(taskScheduler.status()).toMatchObject({ state: "inactive", detail: "task registered" });

    queuePowershell([outFail("", null)]);
    sharedMocks.runCapture.mockReturnValue(fail("", null));
    expect(taskScheduler.status()).toMatchObject({ state: "unknown", detail: "powershell exit unknown" });

    queuePowershell([outFail("", null)]);
    sharedMocks.runCapture.mockReturnValue(ok());
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "task exists but state query failed (exit unknown)",
    });
  });

  it("rejects malformed process identities and mismatched process ids", async () => {
    setMarkerFile(markerJson(4242));
    const taskScheduler = await backend();

    for (const stdout of ["[]", JSON.stringify({ ProcessId: "NaN" }), JSON.stringify({ ProcessId: null })]) {
      queuePowershell([out("Running")], [out(stdout)]);
      expect(taskScheduler.stop()).toEqual({
        ok: false,
        reason: "refusing to taskkill untrusted service runtime marker pid 4242: process query returned malformed JSON",
      });
    }

    queuePowershell([out("Running")], [out(processJson(999))]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason:
        "refusing to taskkill untrusted service runtime marker pid 4242: process query returned pid 999 for pid 4242",
    });

    queuePowershell([out("Running")], [outFail("", null)]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: "refusing to taskkill untrusted service runtime marker pid 4242: powershell exit unknown",
    });
  });

  it("coerces optional process fields before rejecting an unavailable creation time", async () => {
    setMarkerFile(markerJson(4242));
    queuePowershell(
      [out("Running")],
      [
        out(
          processJson(4242, "first-tree-dev daemon start --no-interactive", {
            ParentProcessId: "NaN",
            Name: 123,
            CreationTimeUtc: "",
          }),
        ),
      ],
    );
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: "refusing to taskkill untrusted service runtime marker pid 4242: process creation time is unavailable",
    });
  });

  it("describes empty and truncated non-daemon process commands", async () => {
    setMarkerFile(markerJson(4242));
    const taskScheduler = await backend();

    queuePowershell([out("Running")], [out(processJson(4242, "", { ExecutablePath: "" }))]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason:
        "refusing to taskkill untrusted service runtime marker pid 4242: pid command does not match First Tree daemon start: empty command line",
    });

    const longCommand = "x".repeat(220);
    queuePowershell([out("Running")], [out(processJson(4242, longCommand, { ExecutablePath: "" }))]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringMatching(/pid command does not match First Tree daemon start: x+\.\.\.$/u),
    });
  });

  it("rejects null, invalid-item, and failed supervisor process lists", async () => {
    const taskScheduler = await backend();

    queuePowershell([taskMissing()], [], [out("null")]);
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "supervisor process query returned malformed JSON",
    });

    queuePowershell([taskMissing()], [], [out("[null]")]);
    expect(taskScheduler.status()).toMatchObject({
      state: "unknown",
      detail: "supervisor process query returned malformed JSON",
    });

    queuePowershell([taskMissing()], [], [outFail("", null)]);
    expect(taskScheduler.status()).toMatchObject({ state: "unknown", detail: "powershell exit unknown" });

    queuePowershell([taskMissing()], [], [outFail("initial query denied", 5)]);
    expect(taskScheduler.stop()).toEqual({ ok: false, reason: "initial query denied" });
  });

  it("summarizes a long residual supervisor command after cleanup times out", async () => {
    const process = supervisorJson(777, { Name: 123, CommandLine: "x".repeat(220) });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(70_001);
    queuePowershell([taskMissing()], [], [out(process), out(process)]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringMatching(/supervisor process still running after task end: 123 pid=777 x+\.\.\.$/u),
    });
  });

  it("stringifies primitive marker filesystem failures", async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockImplementation(() => throwUnknown("marker directory denied"));
    queuePowershell([out("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.start()).toEqual({
      ok: false,
      reason: "Unable to inspect runtime markers: marker directory denied",
    });

    fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
    fsMocks.readFileSync.mockImplementation(() => throwUnknown("marker read denied"));
    queuePowershell([out("Running")]);
    expect(taskScheduler.stop()).toEqual({
      ok: false,
      reason: expect.stringContaining("marker read denied"),
    });
  });

  it("skips non-marker files and markers for another runtime context", async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(["notes.txt", "version.json", "home.json", "mode.json"]);
    fsMocks.readFileSync.mockImplementation((path) => {
      const name = String(path);
      if (name.endsWith("version.json")) return markerJson(4242, { version: 2 });
      if (name.endsWith("home.json")) return markerJson(4242, { home: "C:\\Other" });
      return markerJson(4242, { mode: "foreground" });
    });
    queuePowershell([out("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({ state: "inactive", detail: "task state Ready" });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("removes invalid-pid markers before checking process liveness", async () => {
    setMarkerFile(markerJson(0));
    queuePowershell([out("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({ state: "inactive" });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(expect.stringContaining("runtime.json"), { force: true });
  });

  it("treats primitive process-kill failures as an indeterminate live pid", async () => {
    setMarkerFile(markerJson(4242));
    vi.mocked(process.kill).mockImplementation(() => throwUnknown("permission denied"));
    queuePowershell([out("Running")]);
    const taskScheduler = await backend();

    expect(taskScheduler.status()).toMatchObject({ state: "active", pid: 4242 });
  });

  it("skips a marker that dies between listing and stop prevalidation", async () => {
    setMarkerFile(markerJson(4242));
    let killCalls = 0;
    vi.mocked(process.kill).mockImplementation(() => {
      killCalls += 1;
      if (killCalls === 2) throwUnknown(Object.assign(new Error("gone"), { code: "ESRCH" }));
      return true;
    });
    queuePowershell([out("Running"), out("Ready")]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
  });

  it("accepts a marker that dies immediately before the kill phase", async () => {
    setMarkerFile(markerJson(4242));
    let killCalls = 0;
    vi.mocked(process.kill).mockImplementation(() => {
      killCalls += 1;
      if (killCalls === 3) throwUnknown(Object.assign(new Error("gone"), { code: "ESRCH" }));
      return true;
    });
    queuePowershell([out("Running"), out("Ready")], [out(processJson(4242))]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
  });

  it("accepts a marker whose process query reports gone during the kill phase", async () => {
    setMarkerFile(markerJson(4242));
    queuePowershell([out("Running"), out("Ready")], [out(processJson(4242)), outFail("", 3)]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
  });

  it("waits once when a gracefully killed marker exits after the first probe", async () => {
    setMarkerFile(markerJson(4242));
    vi.spyOn(Date, "now").mockReturnValue(0);
    let killCalls = 0;
    vi.mocked(process.kill).mockImplementation(() => {
      killCalls += 1;
      if (killCalls === 5) throwUnknown(Object.assign(new Error("gone"), { code: "ESRCH" }));
      return true;
    });
    queuePowershell([out("Running"), out("Ready")], [out(processJson(4242)), out(processJson(4242))]);
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
    expect(sharedMocks.sleepSync).toHaveBeenCalledWith(200);
  });

  it("covers start, restart, and successful uninstall terminal states", async () => {
    const taskScheduler = await backend();

    queuePowershell([out("Running")]);
    expect(taskScheduler.start()).toEqual({ ok: true, detail: "already running" });

    queuePowershell([outFail("state unavailable", 5)]);
    sharedMocks.runCapture.mockReturnValue(ok());
    expect(taskScheduler.start()).toEqual({ ok: false, reason: "state unavailable" });

    queuePowershell([outFail("restart state unavailable", 5)]);
    expect(taskScheduler.restart()).toEqual({ ok: false, reason: "restart state unavailable" });

    queuePowershell([taskMissing()], [], [out("")]);
    expect(taskScheduler.uninstall()).toMatchObject({ state: "not-installed", detail: undefined });
  });
});
