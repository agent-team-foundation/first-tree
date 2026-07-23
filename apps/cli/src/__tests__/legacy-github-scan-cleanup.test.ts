import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_GITHUB_SCAN_LABEL_PREFIX,
  legacyGithubScanLaunchdDir,
  retireLegacyGithubScanRunner,
} from "../core/legacy-github-scan-cleanup.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const userInfoMock = vi.hoisted(() => vi.fn(() => ({ uid: 501, username: "gandy" })));
const homedirMock = vi.hoisted(() => vi.fn(() => "/Users/gandy"));

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

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

const LEGACY_LABEL = `${LEGACY_GITHUB_SCAN_LABEL_PREFIX}gandy.default`;

function ok(stdout = ""): { status: number; stdout: string; stderr: string } {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr: string): { status: number; stdout: string; stderr: string } {
  return { status: 1, stdout: "", stderr };
}

/** `launchctl list` output: header + one PID\tStatus\tLabel row per label. */
function launchctlList(labels: string[]): string {
  return ["PID\tStatus\tLabel", ...labels.map((label, i) => `${100 + i}\t0\t${label}`)].join("\n");
}

function launchctlCalls(): Array<[string, string[]]> {
  return spawnSyncMock.mock.calls.map((call) => [call[0], call[1]]);
}

let home: string;
let legacyDir: string;

beforeEach(() => {
  home = join(tmpdir(), `ft-legacy-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  homedirMock.mockReturnValue(home);
  userInfoMock.mockReturnValue({ uid: 501, username: "gandy" });
  spawnSyncMock.mockReset();
  execFileSyncMock.mockReset();
  legacyDir = legacyGithubScanLaunchdDir();
  setPlatform("darwin");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  setPlatform(originalPlatform);
});

describe("retireLegacyGithubScanRunner", () => {
  it("does nothing on platforms without launchd", () => {
    setPlatform("linux");
    const result = retireLegacyGithubScanRunner();
    expect(result).toEqual({ checked: false, retiredLabels: [], removedPlists: [], warnings: [] });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is stranded", () => {
    spawnSyncMock.mockReturnValueOnce(ok(launchctlList(["com.apple.Finder", "first-tree"])));
    const result = retireLegacyGithubScanRunner();
    expect(result).toEqual({ checked: true, retiredLabels: [], removedPlists: [], warnings: [] });
    expect(launchctlCalls()).toEqual([["launchctl", ["list"]]]);
  });

  it("boots out a stranded runner and removes its plist, leaving foreign files alone", () => {
    mkdirSync(legacyDir, { recursive: true });
    const plistPath = join(legacyDir, `${LEGACY_LABEL}.plist`);
    writeFileSync(plistPath, "<plist/>");
    const foreignPath = join(legacyDir, "com.other.tool.plist");
    writeFileSync(foreignPath, "<plist/>");

    spawnSyncMock.mockReturnValueOnce(ok(launchctlList(["com.apple.Finder", LEGACY_LABEL]))).mockReturnValueOnce(ok());

    const result = retireLegacyGithubScanRunner();

    expect(result.retiredLabels).toEqual([LEGACY_LABEL]);
    expect(result.removedPlists).toEqual([plistPath]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(foreignPath)).toBe(true);
    expect(existsSync(legacyDir)).toBe(true); // non-empty dirs are never force-removed
    expect(launchctlCalls()).toEqual([
      ["launchctl", ["list"]],
      ["launchctl", ["bootout", `gui/501/${LEGACY_LABEL}`]],
    ]);
  });

  it("removes the legacy launchd dir once it is empty and is idempotent on re-run", () => {
    mkdirSync(legacyDir, { recursive: true });
    const plistPath = join(legacyDir, `${LEGACY_LABEL}.plist`);
    writeFileSync(plistPath, "<plist/>");

    spawnSyncMock.mockReturnValueOnce(ok(launchctlList([LEGACY_LABEL]))).mockReturnValueOnce(ok());
    const first = retireLegacyGithubScanRunner();
    expect(first.retiredLabels).toEqual([LEGACY_LABEL]);
    expect(first.removedPlists).toEqual([plistPath]);
    expect(existsSync(legacyDir)).toBe(false);

    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce(ok(launchctlList([])));
    const second = retireLegacyGithubScanRunner();
    expect(second).toEqual({ checked: true, retiredLabels: [], removedPlists: [], warnings: [] });
    expect(launchctlCalls()).toEqual([["launchctl", ["list"]]]);
  });

  it("boots out a loaded zombie whose plist was already deleted by hand", () => {
    spawnSyncMock.mockReturnValueOnce(ok(launchctlList([LEGACY_LABEL]))).mockReturnValueOnce(ok());
    const result = retireLegacyGithubScanRunner();
    expect(result.retiredLabels).toEqual([LEGACY_LABEL]);
    expect(result.removedPlists).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(launchctlCalls()).toEqual([
      ["launchctl", ["list"]],
      ["launchctl", ["bootout", `gui/501/${LEGACY_LABEL}`]],
    ]);
  });

  it("treats a not-loaded bootout answer as the idempotent case and still removes the plist", () => {
    mkdirSync(legacyDir, { recursive: true });
    const plistPath = join(legacyDir, `${LEGACY_LABEL}.plist`);
    writeFileSync(plistPath, "<plist/>");

    spawnSyncMock
      .mockReturnValueOnce(ok(launchctlList([])))
      .mockReturnValueOnce(fail(`Boot-out failed: 113: Could not find specified service`));

    const result = retireLegacyGithubScanRunner();
    expect(result.retiredLabels).toEqual([]);
    expect(result.removedPlists).toEqual([plistPath]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(plistPath)).toBe(false);
  });

  it("keeps going past an unexpected bootout failure and surfaces it as a warning", () => {
    mkdirSync(legacyDir, { recursive: true });
    const plistPath = join(legacyDir, `${LEGACY_LABEL}.plist`);
    writeFileSync(plistPath, "<plist/>");

    spawnSyncMock
      .mockReturnValueOnce(ok(launchctlList([LEGACY_LABEL])))
      .mockReturnValueOnce(fail("Operation not permitted"));

    const result = retireLegacyGithubScanRunner();
    expect(result.retiredLabels).toEqual([]);
    expect(result.removedPlists).toEqual([plistPath]);
    expect(result.warnings).toEqual([`launchctl bootout gui/501/${LEGACY_LABEL}: Operation not permitted`]);
    expect(existsSync(plistPath)).toBe(false);
  });

  it("still sweeps on-disk plists when launchctl list fails", () => {
    mkdirSync(legacyDir, { recursive: true });
    const plistPath = join(legacyDir, `${LEGACY_LABEL}.plist`);
    writeFileSync(plistPath, "<plist/>");

    spawnSyncMock.mockReturnValueOnce(fail("launchctl exploded")).mockReturnValueOnce(ok());

    const result = retireLegacyGithubScanRunner();
    expect(result.retiredLabels).toEqual([LEGACY_LABEL]);
    expect(result.removedPlists).toEqual([plistPath]);
    expect(result.warnings).toEqual(["launchctl list failed: launchctl exploded"]);
    expect(launchctlCalls()).toEqual([
      ["launchctl", ["list"]],
      ["launchctl", ["bootout", `gui/501/${LEGACY_LABEL}`]],
    ]);
  });

  it("retires multiple stranded profiles in deterministic order", () => {
    mkdirSync(legacyDir, { recursive: true });
    const labelA = `${LEGACY_GITHUB_SCAN_LABEL_PREFIX}gandy.alpha`;
    const labelB = `${LEGACY_GITHUB_SCAN_LABEL_PREFIX}gandy.beta`;
    writeFileSync(join(legacyDir, `${labelB}.plist`), "<plist/>");
    writeFileSync(join(legacyDir, `${labelA}.plist`), "<plist/>");

    spawnSyncMock
      .mockReturnValueOnce(ok(launchctlList([labelB])))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok());

    const result = retireLegacyGithubScanRunner();
    expect(result.retiredLabels).toEqual([labelA, labelB]);
    expect(result.removedPlists.sort()).toEqual([
      join(legacyDir, `${labelA}.plist`),
      join(legacyDir, `${labelB}.plist`),
    ]);
    expect(existsSync(legacyDir)).toBe(false);
    expect(launchctlCalls()).toEqual([
      ["launchctl", ["list"]],
      ["launchctl", ["bootout", `gui/501/${labelA}`]],
      ["launchctl", ["bootout", `gui/501/${labelB}`]],
    ]);
  });
});
