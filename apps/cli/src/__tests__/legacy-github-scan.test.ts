import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retireLegacyGithubScanRunner } from "../core/legacy-github-scan.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const userInfoMock = vi.hoisted(() => vi.fn(() => ({ uid: 501, username: "gandy" })));
const homedirMock = vi.hoisted(() => vi.fn(() => "/Users/gandy"));
const printMocks = vi.hoisted(() => ({
  status: vi.fn(),
  line: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
  execFileSync: execFileSyncMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
    userInfo: userInfoMock,
  };
});

vi.mock("@first-tree/client", () => ({
  createLogger: vi.fn(() => loggerMocks),
}));

vi.mock("../core/output.js", () => ({
  print: printMocks,
}));

const RUNNER_LABEL = "com.first-tree.github-scan.runner.gandy.default";

const originalPlatform = process.platform;
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function legacyLaunchdDir(home: string): string {
  return join(home, ".first-tree", "github-scan", "runner", "launchd");
}

function markerPath(stateDir: string): string {
  return join(stateDir, "legacy-github-scan-runner-retired.json");
}

function spawnOk(stdout = ""): { status: number; stdout: string; stderr: string } {
  return { status: 0, stdout, stderr: "" };
}

function spawnFail(stderr: string, status = 1): { status: number; stdout: string; stderr: string } {
  return { status, stdout: "", stderr };
}

/** `launchctl list` row shape: `PID\tStatus\tLabel` (`-` when not running). */
function launchctlListOutput(labels: string[]): string {
  return labels.map((label) => `-\t0\t${label}`).join("\n");
}

function spawnCalls(): string[][] {
  return spawnSyncMock.mock.calls.map((call) => [call[0], ...(call[1] as string[])]);
}

function bootoutCalls(): string[][] {
  return spawnCalls().filter((args) => args[1] === "bootout");
}

let home: string;
let stateDir: string;

beforeEach(() => {
  home = join(tmpdir(), `ft-995-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(home, "ft-home", "state");
  mkdirSync(home, { recursive: true });
  process.env.FIRST_TREE_HOME = join(home, "ft-home");
  setPlatform("darwin");
  homedirMock.mockReturnValue(home);
  userInfoMock.mockReturnValue({ uid: 501, username: "gandy" });
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(() => spawnOk());
  execFileSyncMock.mockReset();
  printMocks.status.mockClear();
  printMocks.line.mockClear();
  loggerMocks.warn.mockClear();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  setPlatform(originalPlatform);
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
});

describe("retireLegacyGithubScanRunner", () => {
  it("short-circuits on non-darwin with zero I/O", () => {
    setPlatform("linux");
    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(result.checked).toBe(false);
    expect(result.markerWritten).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(markerPath(stateDir))).toBe(false);
  });

  it("short-circuits when the done-marker already exists, leaving residue untouched", () => {
    const plistDir = legacyLaunchdDir(home);
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `${RUNNER_LABEL}.plist`), "<plist/>");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(markerPath(stateDir), "{}\n");

    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });

    expect(result.checked).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(join(plistDir, `${RUNNER_LABEL}.plist`))).toBe(true);
  });

  it("writes only the marker when nothing is stranded", () => {
    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });

    expect(result).toMatchObject({
      checked: true,
      labelsBootedOut: [],
      plistDirRemoved: false,
      markerWritten: true,
      errors: [],
    });
    expect(spawnCalls()).toEqual([["launchctl", "list"]]);
    expect(bootoutCalls()).toEqual([]);
    expect(printMocks.status).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();

    const marker = JSON.parse(readFileSync(markerPath(stateDir), "utf-8")) as Record<string, unknown>;
    expect(marker.version).toBe(1);
    expect(typeof marker.retiredAt).toBe("string");
    expect(marker.labelsBootedOut).toEqual([]);
    expect(marker.plistDirRemoved).toBe(false);
    expect(statSync(markerPath(stateDir)).mode & 0o777).toBe(0o600);
  });

  it("boots out the loaded runner and removes the plist dir (incident state from #995)", () => {
    const plistDir = legacyLaunchdDir(home);
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `${RUNNER_LABEL}.plist`), "<plist/>");
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list" ? spawnOk(launchctlListOutput([RUNNER_LABEL, "com.apple.Spotlight"])) : spawnOk(),
    );

    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });

    expect(result).toMatchObject({
      checked: true,
      labelsBootedOut: [RUNNER_LABEL],
      plistDirRemoved: true,
      markerWritten: true,
      errors: [],
    });
    expect(spawnCalls()).toEqual([
      ["launchctl", "list"],
      ["launchctl", "bootout", `gui/501/${RUNNER_LABEL}`],
    ]);
    expect(existsSync(plistDir)).toBe(false);
    expect(printMocks.status).toHaveBeenCalledTimes(1);
    expect(printMocks.status.mock.calls[0]?.[1]).toMatch(/retired legacy github-scan launchd runner/);
    expect(loggerMocks.warn).not.toHaveBeenCalled();

    const marker = JSON.parse(readFileSync(markerPath(stateDir), "utf-8")) as Record<string, unknown>;
    expect(marker.labelsBootedOut).toEqual([RUNNER_LABEL]);
    expect(marker.plistDirRemoved).toBe(true);
  });

  it("tolerates a not-loaded service while still removing the plist dir (manual-bootout residue)", () => {
    const plistDir = legacyLaunchdDir(home);
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `${RUNNER_LABEL}.plist`), "<plist/>");
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "bootout"
        ? spawnFail(`Could not find service "${RUNNER_LABEL}" in domain for user gui: 501`, 113)
        : spawnOk(),
    );

    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });

    expect(result.errors).toEqual([]);
    expect(result.labelsBootedOut).toEqual([RUNNER_LABEL]);
    expect(result.plistDirRemoved).toBe(true);
    expect(result.markerWritten).toBe(true);
    expect(existsSync(plistDir)).toBe(false);
  });

  it("boots out a runner found only by the launchd sweep (env-override install, no default plist dir)", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list" ? spawnOk(launchctlListOutput(["com.first-tree.github-scan.runner.octo.default"])) : spawnOk(),
    );

    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });

    expect(result.labelsBootedOut).toEqual(["com.first-tree.github-scan.runner.octo.default"]);
    expect(result.plistDirRemoved).toBe(false);
    expect(result.markerWritten).toBe(true);
    expect(bootoutCalls()).toEqual([
      ["launchctl", "bootout", "gui/501/com.first-tree.github-scan.runner.octo.default"],
    ]);
  });

  it("skips the marker when the sweep fails and re-runs detection on the next call", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list" ? spawnFail("launchd simulation failed") : spawnOk(),
    );

    const first = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(first.checked).toBe(true);
    expect(first.markerWritten).toBe(false);
    expect(first.errors.some((e) => e.includes("launchctl list"))).toBe(true);
    expect(loggerMocks.warn).toHaveBeenCalled();
    expect(existsSync(markerPath(stateDir))).toBe(false);

    // Recovery: sweep works again — the next CLI run must redo detection,
    // not treat the failed pass as done.
    spawnSyncMock.mockImplementation(() => spawnOk());
    spawnSyncMock.mockClear();
    const second = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(spawnCalls()).toEqual([["launchctl", "list"]]);
    expect(second.markerWritten).toBe(true);
    expect(second.errors).toEqual([]);
  });

  it("keeps removing the plist dir when bootout fails unexpectedly, skips the marker, and recovers on retry", () => {
    const plistDir = legacyLaunchdDir(home);
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `${RUNNER_LABEL}.plist`), "<plist/>");
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "bootout" ? spawnFail("Boot-out failed: 5: Input/output error", 5) : spawnOk(),
    );

    const first = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(first.labelsBootedOut).toEqual([]);
    expect(first.errors.some((e) => e.includes(`bootout ${RUNNER_LABEL}`))).toBe(true);
    expect(first.plistDirRemoved).toBe(true);
    expect(first.markerWritten).toBe(false);
    expect(existsSync(plistDir)).toBe(false);

    spawnSyncMock.mockImplementation(() => spawnOk());
    const second = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(second.markerWritten).toBe(true);
    expect(second.errors).toEqual([]);
  });

  it("is a no-op on the second consecutive run once the marker exists", () => {
    const first = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(first.markerWritten).toBe(true);
    spawnSyncMock.mockClear();

    const second = retireLegacyGithubScanRunner({ homeDir: home, stateDir });
    expect(second.checked).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("never boots out non-matching plist files, but still removes the tool-private dir wholesale", () => {
    const plistDir = legacyLaunchdDir(home);
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `${RUNNER_LABEL}.plist`), "<plist/>");
    writeFileSync(join(plistDir, "other.plist"), "<plist/>");
    writeFileSync(join(plistDir, "notes.txt"), "operator notes");

    const result = retireLegacyGithubScanRunner({ homeDir: home, stateDir });

    expect(result.errors).toEqual([]);
    expect(bootoutCalls()).toEqual([["launchctl", "bootout", `gui/501/${RUNNER_LABEL}`]]);
    expect(existsSync(plistDir)).toBe(false);
    expect(result.markerWritten).toBe(true);
  });

  it("resolves the default legacy dir from the real home and the marker under the channel home", () => {
    // No opts: homeDir comes from os.homedir() (mocked to the temp home) and
    // stateDir from defaultHome() (FIRST_TREE_HOME, set in beforeEach).
    const plistDir = legacyLaunchdDir(home);
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `${RUNNER_LABEL}.plist`), "<plist/>");
    const channelMarkerPath = join(
      process.env.FIRST_TREE_HOME as string,
      "state",
      "legacy-github-scan-runner-retired.json",
    );

    const result = retireLegacyGithubScanRunner();

    expect(result.markerWritten).toBe(true);
    expect(existsSync(channelMarkerPath)).toBe(true);
    expect(existsSync(plistDir)).toBe(false);
  });
});
