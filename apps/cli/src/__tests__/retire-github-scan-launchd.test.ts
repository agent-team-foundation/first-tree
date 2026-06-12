import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retireLegacyGithubScanLaunchd } from "../core/retire-github-scan-launchd.js";

const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: "", stderr: "" })));
const userInfoMock = vi.hoisted(() => vi.fn(() => ({ uid: 501, username: "gandy" })));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, userInfo: userInfoMock };
});

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function plistBody(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

let home: string;

function launchdDir(): string {
  return join(home, "github-scan", "runner", "launchd");
}

function writePlist(fileName: string, label: string): string {
  const dir = launchdDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, plistBody(label));
  return path;
}

beforeEach(() => {
  setPlatform("darwin");
  spawnSyncMock.mockClear();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  userInfoMock.mockReturnValue({ uid: 501, username: "gandy" });
  home = mkdtempSync(join(tmpdir(), "ft-ghscan-"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  rmSync(home, { recursive: true, force: true });
});

describe("retireLegacyGithubScanLaunchd", () => {
  it("is a no-op when the legacy launchd dir is absent", () => {
    const result = retireLegacyGithubScanLaunchd({ homeDir: home });
    expect(result).toEqual({ bootedOut: [], removedPlists: 0 });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("boots out the label and removes the plist", () => {
    const label = "com.first-tree.github-scan.runner.gandy.default";
    const plistPath = writePlist(`${label}.plist`, label);

    const result = retireLegacyGithubScanLaunchd({ homeDir: home });

    expect(result).toEqual({ bootedOut: [label], removedPlists: 1 });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      ["bootout", `gui/501/${label}`],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(existsSync(plistPath)).toBe(false);
    // The now-empty launchd dir is pruned.
    expect(existsSync(launchdDir())).toBe(false);
  });

  it("uses the Label inside the plist, not the filename", () => {
    const label = "com.first-tree.github-scan.runner.gandy.default";
    writePlist("renamed-by-hand.plist", label);

    const result = retireLegacyGithubScanLaunchd({ homeDir: home });

    expect(result.bootedOut).toEqual([label]);
    expect(spawnSyncMock).toHaveBeenCalledWith("launchctl", ["bootout", `gui/501/${label}`], expect.anything());
  });

  it("falls back to the filename stem when the plist has no Label", () => {
    const dir = launchdDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "com.first-tree.github-scan.runner.x.plist"), "<plist></plist>");

    const result = retireLegacyGithubScanLaunchd({ homeDir: home });

    expect(result.bootedOut).toEqual(["com.first-tree.github-scan.runner.x"]);
    expect(result.removedPlists).toBe(1);
  });

  it("swallows the benign 'no such process' bootout failure and still removes the plist", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "Boot-out failed: 3: No such process" });
    const label = "com.first-tree.github-scan.runner.gandy.default";
    const plistPath = writePlist(`${label}.plist`, label);
    const log = vi.fn();

    const result = retireLegacyGithubScanLaunchd({ homeDir: home, log });

    expect(result.removedPlists).toBe(1);
    expect(existsSync(plistPath)).toBe(false);
    // Not-loaded is expected — it must not be logged as a problem.
    expect(log).not.toHaveBeenCalled();
  });

  it("retires multiple plists", () => {
    const a = "com.first-tree.github-scan.runner.gandy.default";
    const b = "com.first-tree.github-scan.runner.gandy.work";
    writePlist(`${a}.plist`, a);
    writePlist(`${b}.plist`, b);

    const result = retireLegacyGithubScanLaunchd({ homeDir: home });

    expect(result.removedPlists).toBe(2);
    expect(result.bootedOut.sort()).toEqual([a, b].sort());
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("leaves a non-plist file (and its dir) untouched", () => {
    const label = "com.first-tree.github-scan.runner.gandy.default";
    writePlist(`${label}.plist`, label);
    const logPath = join(launchdDir(), "runner.log");
    writeFileSync(logPath, "old crash spam\n");

    const result = retireLegacyGithubScanLaunchd({ homeDir: home });

    expect(result.removedPlists).toBe(1);
    // The stray log keeps the dir alive — we do not blow away non-plist files.
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(launchdDir())).toBe(true);
  });

  it("is a no-op off darwin even if a plist exists", () => {
    setPlatform("linux");
    const label = "com.first-tree.github-scan.runner.gandy.default";
    const plistPath = writePlist(`${label}.plist`, label);

    const result = retireLegacyGithubScanLaunchd({ homeDir: home });

    expect(result).toEqual({ bootedOut: [], removedPlists: 0 });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // Left strictly alone on the wrong platform.
    expect(existsSync(plistPath)).toBe(true);
  });
});
