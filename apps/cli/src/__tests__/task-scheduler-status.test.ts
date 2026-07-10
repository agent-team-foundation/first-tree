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
  resolveCliInvocation: vi.fn(),
  runCapture: vi.fn(),
  runCaptureOut: vi.fn(),
  sleepSync: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  defaultHome: vi.fn(() => "C:\\FirstTree"),
}));

vi.mock("node:fs", () => fsMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/supervisor/shared.js", () => sharedMocks);

const taskQuery = {
  code: 0,
  ok: true,
  stderr: "",
  stdout: "Ready",
};

const supervisorQuery = {
  code: 0,
  ok: true,
  stderr: "",
  stdout: "",
};

function setTaskQuery(stdout: string, code = 0): void {
  taskQuery.code = code;
  taskQuery.ok = code === 0;
  taskQuery.stdout = stdout;
  taskQuery.stderr = "";
}

function setSupervisorQuery(stdout: string): void {
  supervisorQuery.stdout = stdout;
}

function markerJson(pid: number): string {
  return JSON.stringify({
    version: 1,
    pid,
    clientId: "client-1",
    home: "C:\\FirstTree",
    mode: "service",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function supervisorProcessJson(pid: number): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 100,
    Name: "wscript.exe",
    CommandLine: '"C:\\FirstTree\\service\\first-tree-dev-supervisor.vbs"',
    ExecutablePath: "C:\\Windows\\System32\\wscript.exe",
    CreationTimeUtc: "2026-01-01T00:00:00.000Z",
  });
}

async function status(): Promise<
  ReturnType<typeof import("../core/supervisor/task-scheduler.js").taskSchedulerBackend.status>
> {
  const { taskSchedulerBackend } = await import("../core/supervisor/task-scheduler.js");
  return taskSchedulerBackend.status();
}

describe("task scheduler status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    setTaskQuery("Ready");
    setSupervisorQuery("");
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.readFileSync.mockReturnValue("");
    sharedMocks.runCaptureOut.mockImplementation((_program, args) => {
      const script = String(args.at(-1) ?? "");
      if (script.includes("Get-ScheduledTask")) return taskQuery;
      if (script.includes("Get-CimInstance Win32_Process | Where-Object")) return supervisorQuery;
      throw new Error(`unexpected powershell script: ${script}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports not-installed when the task is missing and no runtime or supervisor process is live", async () => {
    setTaskQuery("", 3);

    await expect(status()).resolves.toMatchObject({
      platform: "task-scheduler",
      state: "not-installed",
    });
  });

  it("reports active with the service runtime marker pid when the task is running", async () => {
    setTaskQuery("Running");
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue(["runtime.json"]);
    fsMocks.readFileSync.mockReturnValue(markerJson(4242));

    await expect(status()).resolves.toMatchObject({
      state: "active",
      pid: 4242,
      detail: "pid 4242",
    });
  });

  it("reports unknown when the task is running without a live service runtime marker", async () => {
    setTaskQuery("Running");

    await expect(status()).resolves.toMatchObject({
      state: "unknown",
      detail: "task running but no live service runtime marker",
    });
  });

  it("reports residual supervisor processes when the task is not running", async () => {
    setTaskQuery("Ready");
    setSupervisorQuery(supervisorProcessJson(777));

    await expect(status()).resolves.toMatchObject({
      state: "unknown",
      detail: "task not running but supervisor process is still live",
    });
  });
});
