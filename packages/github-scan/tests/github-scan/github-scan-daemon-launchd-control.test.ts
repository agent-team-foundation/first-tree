import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

const { execSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(() => Buffer.from("/bin/launchctl\n")),
  spawnSyncMock: vi.fn<() => SpawnResult>(),
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
  spawnSync: spawnSyncMock,
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

describe("github-scan launchd control helpers", () => {
  let tmp: string;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "github-scan-launchd-control-"));
    originalPlatform = process.platform;
    setPlatform("darwin");
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: "501\n", stderr: "" }));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("detects launchd support from platform and launchctl availability", async () => {
    const { supportsLaunchd } = await import("../../src/github-scan/engine/daemon/launchd.js");

    setPlatform("linux");
    expect(supportsLaunchd()).toBe(false);

    setPlatform("darwin");
    expect(supportsLaunchd()).toBe(true);

    execSyncMock.mockImplementationOnce(() => {
      throw new Error("missing launchctl");
    });
    expect(supportsLaunchd()).toBe(false);
  });

  it("resolves launchd domain and rejects failed or empty uid output", async () => {
    const { launchdDomain } = await import("../../src/github-scan/engine/daemon/launchd.js");

    expect(launchdDomain()).toBe("gui/501");

    spawnSyncMock.mockReturnValueOnce({ status: 1, stderr: "id failed" });
    expect(() => launchdDomain()).toThrow("id failed");

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "\n" });
    expect(() => launchdDomain()).toThrow("numeric user id");
  });

  it("resolves launchd env vars from direct env, login shell, and failure paths", async () => {
    const { resolveLaunchdEnvVar } = await import("../../src/github-scan/engine/daemon/launchd.js");

    expect(resolveLaunchdEnvVar("OPENAI_API_KEY", { OPENAI_API_KEY: " direct " })).toBe(" direct ");

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "from-shell" });
    expect(resolveLaunchdEnvVar("OPENAI_API_KEY", {})).toBe("from-shell");

    spawnSyncMock.mockReturnValueOnce({ status: 1, stderr: "no shell" });
    expect(resolveLaunchdEnvVar("OPENAI_API_KEY", {})).toBeUndefined();

    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    expect(resolveLaunchdEnvVar("OPENAI_API_KEY", {})).toBeUndefined();
  });

  it("bootstraps a launchd job, writes the plist, and accepts kickstart race code 113", async () => {
    const calls: string[] = [];
    spawnSyncMock.mockImplementation((program: string, args: readonly string[]): SpawnResult => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "id") return { status: 0, stdout: "501\n", stderr: "" };
      if (args[0] === "kickstart") return { status: 113, stderr: "already running" };
      return { status: 0, stdout: "", stderr: "" };
    });
    const { bootstrapLaunchdJob, launchdLabel, launchdPlistPath } = await import(
      "../../src/github-scan/engine/daemon/launchd.js"
    );

    const result = bootstrapLaunchdJob({
      runnerHome: tmp,
      login: "alice@example.test",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["github", "scan", "daemon"],
      logPath: join(tmp, "daemon.log"),
      workingDirectory: tmp,
      env: { HOME: tmp, PATH: "/usr/bin" },
    });

    const label = launchdLabel("alice@example.test", "default");
    expect(result).toEqual({ label, domain: "gui/501", plistPath: launchdPlistPath(tmp, label) });
    expect(existsSync(result.plistPath)).toBe(true);
    expect(calls).toContain(`launchctl bootout gui/501 ${result.plistPath}`);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${result.plistPath}`);
    expect(calls).toContain(`launchctl kickstart -k gui/501/${label}`);
  });

  it("surfaces bootstrap and kickstart failures", async () => {
    const { bootstrapLaunchdJob } = await import("../../src/github-scan/engine/daemon/launchd.js");
    const base = {
      runnerHome: tmp,
      login: "alice",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["github", "scan", "daemon"],
      logPath: join(tmp, "daemon.log"),
      env: { HOME: tmp, PATH: "/usr/bin" },
    };

    spawnSyncMock.mockImplementation((program: string, args: readonly string[]): SpawnResult => {
      if (program === "id") return { status: 0, stdout: "501\n", stderr: "" };
      if (args[0] === "bootstrap") return { status: 5, stderr: "bootstrap failed" };
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(() => bootstrapLaunchdJob(base)).toThrow("bootstrap failed");

    spawnSyncMock.mockImplementation((program: string, args: readonly string[]): SpawnResult => {
      if (program === "id") return { status: 0, stdout: "501\n", stderr: "" };
      if (args[0] === "kickstart") return { status: 5, stderr: "kickstart failed" };
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(() => bootstrapLaunchdJob(base)).toThrow("kickstart failed");
  });

  it("stops launchd jobs only when the plist and domain are available", async () => {
    const { launchdLabel, launchdPlistPath, stopLaunchdJob } = await import(
      "../../src/github-scan/engine/daemon/launchd.js"
    );
    const label = launchdLabel("alice", "default");
    const plist = launchdPlistPath(tmp, label);

    stopLaunchdJob(tmp, "alice", "default");
    expect(spawnSyncMock).not.toHaveBeenCalled();

    mkdirSync(join(tmp, "launchd"), { recursive: true });
    writeFileSync(plist, "<plist />");

    spawnSyncMock.mockReturnValueOnce({ status: 1, stderr: "id failed" });
    stopLaunchdJob(tmp, "alice", "default");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    spawnSyncMock.mockClear();
    spawnSyncMock.mockImplementation(
      (program: string): SpawnResult => (program === "id" ? { status: 0, stdout: "501\n" } : { status: 0, stdout: "" }),
    );
    stopLaunchdJob(tmp, "alice", "default");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      ["bootout", "gui/501", plist],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });
});
