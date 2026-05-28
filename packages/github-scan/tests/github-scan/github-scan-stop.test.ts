import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findServiceLock: vi.fn<() => unknown>(() => null),
  isLockStale: vi.fn(() => false),
  rmSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
  stopLaunchdJob: vi.fn(),
  supportsLaunchd: vi.fn(() => true),
  resolveDaemonIdentity: vi.fn<() => unknown>(() => ({
    gitProtocol: "https",
    host: "github.com",
    login: "alice",
    scopes: [],
  })),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ rmSync: mocks.rmSync }));
vi.mock("../../src/github-scan/engine/daemon/claim.js", () => ({
  findServiceLock: mocks.findServiceLock,
  isLockStale: mocks.isLockStale,
  serviceLockDir: () => "/tmp/github-scan/locks/github.com/alice/default",
}));
vi.mock("../../src/github-scan/engine/daemon/identity.js", () => ({
  resolveDaemonIdentity: mocks.resolveDaemonIdentity,
}));
vi.mock("../../src/github-scan/engine/daemon/launchd.js", () => ({
  stopLaunchdJob: mocks.stopLaunchdJob,
  supportsLaunchd: mocks.supportsLaunchd,
}));
vi.mock("../../src/github-scan/engine/daemon/runner-skeleton.js", () => ({
  resolveRunnerHome: () => "/tmp/github-scan",
}));
vi.mock("../../src/github-scan/engine/runtime/config.js", () => ({
  loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
}));

describe("runStop", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.findServiceLock.mockReturnValue(null);
    mocks.isLockStale.mockReturnValue(false);
    mocks.rmSync.mockClear();
    mocks.spawnSync.mockReturnValue({ status: 0 });
    mocks.stopLaunchdJob.mockClear();
    mocks.supportsLaunchd.mockReturnValue(true);
    mocks.resolveDaemonIdentity.mockReturnValue({
      host: "github.com",
      login: "alice",
      scopes: [],
      gitProtocol: "https",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops launchd first and returns cleanly when no lock exists", async () => {
    const { runStop } = await import("../../src/github-scan/engine/commands/stop.js");
    const lines: string[] = [];

    await expect(
      runStop(["--home", "/tmp/home", "--profile=work"], { write: (line) => lines.push(line) }),
    ).resolves.toBe(0);

    expect(mocks.stopLaunchdJob).toHaveBeenCalledWith("/tmp/home", "alice", "work");
    expect(lines.join("\n")).toContain("no running github-scan-runner");
  });

  it("reports identity resolution failures without touching locks", async () => {
    mocks.resolveDaemonIdentity.mockImplementationOnce(() => {
      throw new Error("gh auth missing");
    });
    const { runStop } = await import("../../src/github-scan/engine/commands/stop.js");
    const lines: string[] = [];

    await expect(runStop([], { write: (line) => lines.push(line) })).resolves.toBe(1);

    expect(mocks.findServiceLock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("gh auth missing");
  });

  it("removes a stale lock instead of sending kill", async () => {
    mocks.findServiceLock.mockReturnValue({ pid: 1234, heartbeat_epoch: 1, active_tasks: 0, note: "" });
    mocks.isLockStale.mockReturnValue(true);
    const { runStop } = await import("../../src/github-scan/engine/commands/stop.js");
    const lines: string[] = [];

    await expect(runStop([], { write: (line) => lines.push(line) })).resolves.toBe(0);

    expect(mocks.rmSync).toHaveBeenCalledWith("/tmp/github-scan/locks/github.com/alice/default", {
      recursive: true,
      force: true,
    });
    expect(mocks.spawnSync).not.toHaveBeenCalledWith("kill", expect.anything(), expect.anything());
    expect(lines.join("\n")).toContain("removed stale github-scan-runner lock for pid 1234");
  });

  it("sends SIGTERM, waits for process exit, and removes the live lock", async () => {
    mocks.findServiceLock.mockReturnValue({ pid: 5678, heartbeat_epoch: 1, active_tasks: 1, note: "busy" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("not alive");
    });
    const { runStop } = await import("../../src/github-scan/engine/commands/stop.js");
    const lines: string[] = [];

    await expect(runStop([], { write: (line) => lines.push(line) })).resolves.toBe(0);

    expect(mocks.spawnSync).toHaveBeenCalledWith("kill", ["-TERM", "5678"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(killSpy).toHaveBeenCalledWith(5678, 0);
    expect(mocks.rmSync).toHaveBeenCalledWith("/tmp/github-scan/locks/github.com/alice/default", {
      recursive: true,
      force: true,
    });
    expect(lines.join("\n")).toContain("stopped github-scan-runner pid 5678");
  });

  it("returns failure when SIGTERM cannot be sent", async () => {
    mocks.findServiceLock.mockReturnValue({ pid: 1111, heartbeat_epoch: 1, active_tasks: 1, note: "" });
    mocks.spawnSync.mockReturnValueOnce({ status: 2 });
    const { runStop } = await import("../../src/github-scan/engine/commands/stop.js");
    const lines: string[] = [];

    await expect(runStop([], { write: (line) => lines.push(line) })).resolves.toBe(1);

    expect(lines.join("\n")).toContain("kill 1111 failed (exit 2)");
  });
});
