import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";

type SpawnResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => "/usr/local/bin/first-tree-dev\n"),
  spawnSyncMock: vi.fn((program: string, args: readonly string[]): SpawnResult => {
    if (program === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active\n" };
    if (program === "systemctl" && args.includes("show")) return { status: 0, stdout: "4242\n" };
    if (program === "loginctl" && args.includes("show-user")) return { status: 0, stdout: "no\n" };
    return { status: 0, stdout: "", stderr: "" };
  }),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

describe("service install control paths", () => {
  let tmp: string;
  let originalPlatform: NodeJS.Platform;
  let originalXdg: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockClear();
    execFileSyncMock.mockClear();
    tmp = join(tmpdir(), `first-tree-service-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    originalPlatform = process.platform;
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalHome = process.env.FIRST_TREE_HOME;
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    process.env.FIRST_TREE_HOME = join(tmp, "home");
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports linux service state from systemd and MainPID", async () => {
    const unitDir = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, channelConfig.serviceUnitFile), "[Unit]\n");

    const { getClientServiceStatus } = await import("../core/service-install.js");

    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      label: channelConfig.serviceUnitFile,
      pid: 4242,
      state: "active",
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "is-active", channelConfig.serviceUnitFile],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("installs, starts, stops, restarts, and uninstalls through systemd", async () => {
    const {
      installClientService,
      restartClientService,
      startClientService,
      stopClientService,
      uninstallClientService,
    } = await import("../core/service-install.js");

    const installed = installClientService();
    expect(installed).toMatchObject({ platform: "systemd", state: "active" });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "daemon-reload"],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "enable", "--now", channelConfig.serviceUnitFile],
      expect.objectContaining({ timeout: 10_000 }),
    );

    expect(startClientService()).toEqual({ ok: true });
    expect(stopClientService()).toEqual({ ok: true });
    expect(restartClientService()).toEqual({ ok: true });
    expect(uninstallClientService()).toMatchObject({ platform: "systemd", state: "not-installed" });
  });

  it("surfaces service manager failures and tolerates missing stops", async () => {
    const { restartClientService, startClientService, stopClientService } = await import("../core/service-install.js");

    spawnSyncMock.mockImplementationOnce(() => ({ status: 1, stderr: "dbus unavailable" }));
    expect(startClientService()).toEqual({ ok: false, reason: "dbus unavailable" });

    spawnSyncMock.mockImplementationOnce(() => ({ status: 1, stderr: "Unit not loaded" }));
    expect(stopClientService()).toEqual({ ok: true, detail: "not running" });

    spawnSyncMock.mockImplementationOnce(() => ({ status: 1, stderr: "restart failed" }));
    expect(restartClientService()).toEqual({ ok: false, reason: "restart failed" });
  });

  it("detects unit-file drift against the current invocation", async () => {
    const unitDir = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const unitPath = join(unitDir, channelConfig.serviceUnitFile);
    writeFileSync(unitPath, "stale unit");

    const { isServiceUnitDriftDetected, renderSystemdUnit } = await import("../core/service-install.js");

    expect(isServiceUnitDriftDetected()).toBe(true);
    writeFileSync(unitPath, renderSystemdUnit({ kind: "bin", program: "/usr/local/bin/first-tree-dev" }));
    expect(isServiceUnitDriftDetected()).toBe(false);
  });

  it("returns unsupported status and failed control operations outside linux or darwin", async () => {
    const { getClientServiceStatus, isServiceSupported, startClientService } = await import(
      "../core/service-install.js"
    );

    setPlatform("win32");

    expect(isServiceSupported()).toBe(false);
    expect(getClientServiceStatus()).toMatchObject({ platform: "unsupported", state: "not-installed" });
    expect(startClientService()).toEqual({ ok: false, reason: "service control not supported on win32" });
  });
});
