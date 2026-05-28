import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";

type SpawnResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

const { execFileSyncMock, osMockState, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => "/usr/local/bin/first-tree-dev\n"),
  osMockState: {
    home: "/tmp/first-tree-launchd-home",
    uid: 501,
    username: "ada",
  },
  spawnSyncMock: vi.fn((program: string, args: readonly string[]): SpawnResult => {
    if (program !== "launchctl") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "print") return { status: 0, stdout: "state = running\npid = 777\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  }),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: () => osMockState.home,
  userInfo: () => ({ uid: osMockState.uid, username: osMockState.username }),
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

function launchdPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
}

describe("service install launchd paths", () => {
  let tmp: string;
  let originalPlatform: NodeJS.Platform;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = `/tmp/first-tree-launchd-${process.pid}-${Date.now()}`;
    osMockState.home = tmp;
    originalPlatform = process.platform;
    originalHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = join(tmp, "first-tree-home");
    mkdirSync(tmp, { recursive: true });
    setPlatform("darwin");
    spawnSyncMock.mockImplementation((program: string, args: readonly string[]): SpawnResult => {
      if (program !== "launchctl") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "print") return { status: 0, stdout: "state = running\npid = 777\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("renders a launchd plist with escaped arguments, home, path, and proxy env", async () => {
    const { renderPlist } = await import("../core/service-install.js");

    const plist = renderPlist(
      { kind: "node", program: "/opt/node & tools/node", args: ["/tmp/first tree/cli.mjs"] },
      { HTTPS_PROXY: "http://proxy.example.test?a=1&b=2" },
    );

    expect(plist).toContain("<string>/opt/node &amp; tools/node</string>");
    expect(plist).toContain("<string>/tmp/first tree/cli.mjs</string>");
    expect(plist).toContain("<key>FIRST_TREE_HOME</key>");
    expect(plist).toContain(process.env.FIRST_TREE_HOME);
    expect(plist).toContain("<key>HTTPS_PROXY</key>");
    expect(plist).toContain("a=1&amp;b=2");
  });

  it("reports, starts, stops, restarts, and uninstalls an existing launchd service", async () => {
    const plistPath = launchdPlistPath(tmp);
    mkdirSync(join(tmp, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, "<plist />");

    const {
      getClientServiceStatus,
      restartClientService,
      startClientService,
      stopClientService,
      uninstallClientService,
    } = await import("../core/service-install.js");

    expect(getClientServiceStatus()).toMatchObject({
      detail: "pid 777",
      label: channelConfig.launchdLabel,
      pid: 777,
      platform: "launchd",
      state: "active",
      unitPath: plistPath,
    });

    expect(startClientService()).toEqual({ ok: true });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", `gui/501/${channelConfig.launchdLabel}`],
      expect.objectContaining({ timeout: 10_000 }),
    );

    expect(restartClientService()).toEqual({ ok: true });
    expect(stopClientService()).toEqual({ ok: true });
    expect(uninstallClientService()).toMatchObject({ platform: "launchd", state: "not-installed" });
    expect(existsSync(plistPath)).toBe(false);
  });

  it("installs launchd with bootout eviction, bootstrap retry, enable warning, and final state", async () => {
    const calls: string[] = [];
    spawnSyncMock.mockImplementation((program: string, args: readonly string[]): SpawnResult => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program !== "launchctl") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "bootout") return { status: 1, stderr: "Could not find service" };
      if (args[0] === "print") {
        const printCount = calls.filter((call) => call.includes("launchctl print")).length;
        if (printCount === 1) return { status: 1, stderr: "not found" };
        return { status: 0, stdout: "state = running\npid = 888\n", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        const bootstrapCount = calls.filter((call) => call.includes("launchctl bootstrap")).length;
        if (bootstrapCount === 1) return { status: 1, stderr: "Input/output error" };
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "enable") return { status: 1, stderr: "already enabled" };
      return { status: 0, stdout: "", stderr: "" };
    });

    const { installClientService, isServiceUnitDriftDetected } = await import("../core/service-install.js");

    const installed = installClientService();

    expect(installed).toMatchObject({ detail: "pid 888", pid: 888, platform: "launchd", state: "active" });
    expect(existsSync(launchdPlistPath(tmp))).toBe(true);
    expect(calls.some((call) => call.includes("launchctl bootstrap gui/501"))).toBe(true);
    expect(isServiceUnitDriftDetected()).toBe(false);
  });

  it("surfaces launchd control failures and missing plist states", async () => {
    const { getClientServiceStatus, restartClientService, startClientService, stopClientService } = await import(
      "../core/service-install.js"
    );

    expect(getClientServiceStatus()).toMatchObject({ platform: "launchd", state: "not-installed" });
    expect(startClientService()).toEqual({ ok: false, reason: "service not installed" });
    expect(restartClientService()).toEqual({ ok: false, reason: "service not installed" });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stderr: "launchd busy" });
    expect(stopClientService()).toEqual({ ok: false, reason: "launchd busy" });
  });
});
