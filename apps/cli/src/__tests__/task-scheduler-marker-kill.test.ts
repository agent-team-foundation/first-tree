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

function taskQueryFailure(stderr: string, code = 1): ShellOutResult {
  return { ok: false, stderr, code };
}

function processGone(): ShellOutResult {
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

function daemonProcessJson(pid: number): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 100,
    Name: "node.exe",
    CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\FirstTree\\cli\\index.mjs" daemon start --no-interactive',
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CreationTimeUtc: "2026-01-01T00:00:01.000Z",
  });
}

async function backend(): Promise<typeof import("../core/supervisor/task-scheduler.js").taskSchedulerBackend> {
  const { taskSchedulerBackend } = await import("../core/supervisor/task-scheduler.js");
  return taskSchedulerBackend;
}

function queueTaskQueries(results: readonly ShellOutResult[], processResult: ShellOutResult): void {
  const queue = [...results];
  sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
    const script = String(args.at(-1) ?? "");
    if (script.includes("Get-ScheduledTask")) return queue.shift() ?? taskState("Ready");
    if (script.includes("ProcessId = 4242")) return processResult;
    if (script.includes("Get-CimInstance Win32_Process | Where-Object")) return { ok: true, stdout: "" };
    throw new Error(`unexpected powershell script: ${script}`);
  });
}

function setLiveMarker(): void {
  fsMocks.existsSync.mockReturnValue(true);
  fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
  fsMocks.readFileSync.mockReturnValue(markerJson(4242));
}

function setPidAliveUntilTaskkill(forcedOnly = false): void {
  let killed = false;
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (killed) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  sharedMocks.runCapture.mockImplementation((_program, args) => {
    if (args.includes("/PID") && (!forcedOnly || args.includes("/F"))) killed = true;
    return ok();
  });
}

describe("task scheduler runtime marker stop paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.readFileSync.mockReturnValue("");
    sharedMocks.runCapture.mockReturnValue(ok());
    queueTaskQueries([taskState("Ready")], { ok: true, stdout: daemonProcessJson(4242) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("kills a trusted service runtime marker before ending a running task", async () => {
    setLiveMarker();
    setPidAliveUntilTaskkill();
    queueTaskQueries([taskState("Running"), taskState("Ready")], { ok: true, stdout: daemonProcessJson(4242) });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
    expect(sharedMocks.runCapture).toHaveBeenCalledWith(
      "taskkill.exe",
      expect.arrayContaining(["/PID", "4242"]),
      10_000,
    );
    expect(sharedMocks.runCapture).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining(["/End"]), 10_000);
  });

  it("escalates to forced taskkill when the graceful kill does not stop the marker pid", async () => {
    setLiveMarker();
    setPidAliveUntilTaskkill(true);
    const times = [0, 6000, 12_000, 18_000, 24_000, 24_000];
    vi.spyOn(Date, "now").mockImplementation(() => {
      return times.shift() ?? 24_000;
    });
    queueTaskQueries([taskState("Running"), taskState("Ready")], { ok: true, stdout: daemonProcessJson(4242) });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
    expect(sharedMocks.runCapture).toHaveBeenCalledWith(
      "taskkill.exe",
      expect.arrayContaining(["/PID", "4242", "/F"]),
      10_000,
    );
  });

  it("reports the forced taskkill failure when the marker pid remains alive", async () => {
    setLiveMarker();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    let tick = -1;
    vi.spyOn(Date, "now").mockImplementation(() => {
      tick += 1;
      return tick * 6000;
    });
    sharedMocks.runCapture.mockImplementation((_program, args) => (args.includes("/PID") ? fail("denied", 5) : ok()));
    queueTaskQueries([taskState("Running")], { ok: true, stdout: daemonProcessJson(4242) });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: false, reason: "denied" });
  });

  it("reports when the scheduled task remains running after the end request", async () => {
    queueTaskQueries([taskState("Running"), taskState("Running")], { ok: true, stdout: daemonProcessJson(4242) });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: false, reason: "task did not stop: task running" });
  });

  it("ignores a marker pid that disappears between liveness and trust checks", async () => {
    setLiveMarker();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    queueTaskQueries([taskState("Running"), taskState("Ready")], processGone());
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: true });
    expect(sharedMocks.runCapture).not.toHaveBeenCalledWith(
      "taskkill.exe",
      expect.arrayContaining(["/PID", "4242"]),
      10_000,
    );
  });

  it("reports task state query errors after the end request", async () => {
    queueTaskQueries([taskState("Running"), taskQueryFailure("still busy", 9)], {
      ok: true,
      stdout: daemonProcessJson(4242),
    });
    const taskScheduler = await backend();

    expect(taskScheduler.stop()).toEqual({ ok: false, reason: "task did not stop: still busy" });
  });
});
