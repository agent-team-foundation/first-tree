import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";
import {
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  isServiceUnitDriftDetected,
  refreshClientServiceUnitForUpdate,
  renderLaunchdWrapper,
  renderPlist,
  renderSystemdUnit,
  resolveCliInvocation,
  restartClientService,
  startClientService,
  stopClientService,
  uninstallClientService,
} from "../core/service-install.js";

const printMocks = vi.hoisted(() => ({
  line: vi.fn(),
}));

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

vi.mock("../core/output.js", () => ({
  print: printMocks,
}));

const originalPlatform = process.platform;
const originalArgv = [...process.argv];
const originalExecPath = process.execPath;
const originalCwd = process.cwd;
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function setExecPath(value: string): void {
  Object.defineProperty(process, "execPath", { configurable: true, value });
}

function tempHome(): string {
  return join(tmpdir(), `ft-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

let home: string;

beforeEach(() => {
  home = tempHome();
  mkdirSync(home, { recursive: true });
  process.env.FIRST_TREE_HOME = join(home, "ft-home");
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  process.argv = ["node", "/repo/dist/cli/index.mjs"];
  setExecPath("/opt/node/bin/node");
  process.cwd = () => "/repo";
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  homedirMock.mockReturnValue(home);
  userInfoMock.mockReturnValue({ uid: 501, username: "gandy" });
  printMocks.line.mockClear();
  setPlatform(originalPlatform);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  process.argv = [...originalArgv];
  setExecPath(originalExecPath);
  process.cwd = originalCwd;
  setPlatform(originalPlatform);
});

describe("service install helpers", () => {
  it("resolves the channel bin when it is on PATH and falls back to node plus script", () => {
    execFileSyncMock.mockReturnValueOnce(`/tmp/bin/${channelConfig.binName}\n`);
    expect(resolveCliInvocation()).toEqual({ kind: "bin", program: `/tmp/bin/${channelConfig.binName}` });

    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    process.argv = ["node", "dist/cli/index.mjs"];
    expect(resolveCliInvocation()).toEqual({
      kind: "node",
      program: "/opt/node/bin/node",
      args: ["/repo/dist/cli/index.mjs"],
    });

    process.argv = ["node"];
    expect(() => resolveCliInvocation()).toThrow("Cannot resolve CLI entry point");
  });

  it("renders service templates with escaped values and quoted shell arguments", () => {
    const plist = renderPlist("/tmp/First & Tree");
    expect(plist).toContain("<string>/tmp/First &amp; Tree</string>");
    expect(plist).toContain("<key>FIRST_TREE_HOME</key>");
    expect(plist).toContain(process.env.FIRST_TREE_HOME);
    // The service unit no longer bakes proxy env in — the daemon reads the
    // user-owned daemon.env instead (compatibility, not management).
    expect(plist).not.toContain("HTTP_PROXY");

    const wrapper = renderLaunchdWrapper({
      kind: "node",
      program: "/opt/My Node/node",
      args: ["/tmp/cli path/index.mjs"],
    });
    expect(wrapper).toContain('exec "/opt/My Node/node" "/tmp/cli path/index.mjs" daemon start --no-interactive');

    const unit = renderSystemdUnit({ kind: "bin", program: "/usr/local/bin/first tree" });
    expect(unit).toContain('ExecStart="/usr/local/bin/first tree" daemon start --no-interactive');
    expect(unit).toContain(`Environment=FIRST_TREE_HOME=${process.env.FIRST_TREE_HOME}`);
    expect(unit).not.toContain("HTTPS_PROXY");
  });

  it("lifts a proxy baked into a prior launchd plist into the user-owned daemon.env (upgrade buffer)", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    // A pre-redesign plist that baked the user's proxy straight into the unit.
    writeFileSync(
      plistPath,
      "<plist><dict>" +
        "<key>HTTP_PROXY</key><string>http://127.0.0.1:7897</string>" +
        "<key>NO_PROXY</key><string>localhost,127.0.0.1</string>" +
        "</dict></plist>",
    );
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 1\n", stderr: "" });

    installClientService();

    const envPath = join(process.env.FIRST_TREE_HOME ?? "", "daemon.env");
    const env = readFileSync(envPath, "utf-8");
    expect(env).toContain("HTTP_PROXY=http://127.0.0.1:7897");
    expect(env).toContain("NO_PROXY=localhost,127.0.0.1");
    // The freshly written plist no longer carries the proxy.
    expect(readFileSync(plistPath, "utf-8")).not.toContain("HTTP_PROXY");
  });

  it("never overwrites an existing user-owned daemon.env during migration", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "<plist><dict><key>HTTP_PROXY</key><string>http://baked:1</string></dict></plist>");
    const envPath = join(process.env.FIRST_TREE_HOME ?? "", "daemon.env");
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, "HTTPS_PROXY=http://user-set:2\n");

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 1\n", stderr: "" });

    installClientService();

    expect(readFileSync(envPath, "utf-8")).toBe("HTTPS_PROXY=http://user-set:2\n");
  });

  it("reports support by platform", () => {
    setPlatform("darwin");
    expect(isServiceSupported()).toBe(true);
    setPlatform("linux");
    expect(isServiceSupported()).toBe(true);
    setPlatform("win32");
    expect(isServiceSupported()).toBe(false);
  });

  it("reports launchd states without leaking launchctl stderr", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");

    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "state = running\npid = 123\n",
      stderr: "",
    });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "launchd",
      state: "active",
      pid: 123,
      detail: "pid 123",
    });

    spawnSyncMock.mockReturnValueOnce({ status: 3, stdout: "", stderr: "Could not find service" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "launchd",
      state: "inactive",
      detail: "plist present but not loaded",
    });
  });

  it("reports systemd states and main pid", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "456\n", stderr: "" });

    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "active",
      pid: 456,
      detail: "pid 456",
    });

    spawnSyncMock.mockReturnValueOnce({ status: 3, stdout: "inactive\n", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "inactive",
      detail: "inactive",
    });
  });

  it("detects service unit drift from missing and changed files", () => {
    setPlatform("linux");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    expect(isServiceUnitDriftDetected()).toBe(true);

    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "stale");
    expect(isServiceUnitDriftDetected()).toBe(true);

    writeFileSync(
      unitPath,
      renderSystemdUnit({ kind: "node", program: process.execPath, args: [process.argv[1] ?? ""] }),
    );
    expect(isServiceUnitDriftDetected()).toBe(false);
  });

  it("starts, stops, and restarts services through the platform manager", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });
    expect(stopClientService()).toEqual({ ok: true });
    expect(restartClientService()).toEqual({ ok: true });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "Unit not found" });
    expect(stopClientService()).toEqual({ ok: true, detail: "not running" });

    setPlatform("win32");
    expect(startClientService()).toEqual({ ok: false, reason: "service control not supported on win32" });
    expect(stopClientService()).toEqual({ ok: false, reason: "service control not supported on win32" });
    expect(restartClientService()).toEqual({ ok: false, reason: "service control not supported on win32" });
  });

  it("uses launchctl bootstrap and kickstart paths for launchd control", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });

    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "loaded", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" });
    expect(stopClientService()).toEqual({ ok: true, detail: "not running" });

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: true });
  });

  it("installs a systemd user service, enables linger, and reports the running process", () => {
    setPlatform("linux");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "no\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "789\n", stderr: "" });

    const info = installClientService();
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    const unit = readFileSync(unitPath, "utf-8");

    expect(info).toMatchObject({
      platform: "systemd",
      label: channelConfig.serviceUnitFile,
      state: "active",
      pid: 789,
      detail: "pid 789",
      unitPath,
    });
    expect(existsSync(join(process.env.FIRST_TREE_HOME ?? "", "logs"))).toBe(true);
    expect(unit).toContain(`${process.execPath} ${process.argv[1]} daemon start --no-interactive`);
    expect(unit).toContain(`Environment=FIRST_TREE_HOME=${process.env.FIRST_TREE_HOME}`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["loginctl", ["show-user", "gandy", "-p", "Linger", "--value"]],
      ["loginctl", ["enable-linger", "gandy"]],
      ["systemctl", ["--user", "enable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "is-active", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "show", channelConfig.serviceUnitFile, "-p", "MainPID", "--value"]],
    ]);
  });

  it("surfaces systemd install and uninstall warnings", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "reload failed" });
    expect(() => installClientService()).toThrow("systemctl --user daemon-reload failed: reload failed");

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "no\n", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "linger denied" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "enable failed" });
    expect(() => installClientService()).toThrow("systemctl --user enable --now");
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("loginctl enable-linger failed: linger denied"),
    );

    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "disable failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "reload failed" });
    expect(uninstallClientService()).toMatchObject({ state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("systemctl disable during uninstall"));
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("systemctl daemon-reload during uninstall"));
  });

  it("migrates quoted systemd proxy env and ignores migration write failures", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(
      unitPath,
      'Environment=HTTP_PROXY="http://proxy.example:8080"\nEnvironment=NO_PROXY="localhost,127.0.0.1"\n',
    );
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "yes\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });

    installClientService();

    const envPath = join(process.env.FIRST_TREE_HOME ?? "", "daemon.env");
    expect(readFileSync(envPath, "utf-8")).toContain("HTTP_PROXY=http://proxy.example:8080");
    expect(readFileSync(envPath, "utf-8")).toContain("NO_PROXY=localhost,127.0.0.1");
  });

  it("handles systemd linger already enabled and unreadable drift checks", () => {
    setPlatform("linux");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "yes\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });

    expect(installClientService()).toMatchObject({ platform: "systemd", state: "inactive" });
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["loginctl", ["show-user", "gandy", "-p", "Linger", "--value"]],
      ["systemctl", ["--user", "enable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "is-active", channelConfig.serviceUnitFile]],
    ]);

    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    rmSync(unitPath, { force: true });
    mkdirSync(unitPath, { recursive: true });
    expect(isServiceUnitDriftDetected()).toBe(true);
  });

  it("reports systemd command timeouts from captured status and control calls", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock.mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "inactive",
      detail: "unit present but not active",
    });

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });
    expect(installClientService()).toMatchObject({ platform: "systemd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger failed"));

    spawnSyncMock.mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
    expect(startClientService()).toEqual({
      ok: false,
      reason: expect.stringContaining("systemctl timed out"),
    });
  });

  it("uninstalls a systemd service and reloads the user manager", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "stale");
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Unit not found" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    expect(uninstallClientService()).toMatchObject({
      platform: "systemd",
      label: channelConfig.serviceUnitFile,
      state: "not-installed",
      unitPath,
    });
    expect(existsSync(unitPath)).toBe(false);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "disable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
  });

  it("installs launchd service files and tolerates an initially unloaded label", () => {
    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "service not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 321\n", stderr: "" });

    const info = installClientService();
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);

    expect(info).toMatchObject({
      platform: "launchd",
      label: channelConfig.launchdLabel,
      state: "active",
      pid: 321,
      detail: "pid 321",
      unitPath: plistPath,
    });
    expect(readFileSync(wrapperPath, "utf-8")).toContain(
      `exec ${process.execPath} ${process.argv[1]} daemon start --no-interactive`,
    );
    expect(readFileSync(plistPath, "utf-8")).toContain(`<string>${wrapperPath}</string>`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["launchctl", ["bootout", `gui/501/${channelConfig.launchdLabel}`]],
      ["launchctl", ["print", `gui/501/${channelConfig.launchdLabel}`]],
      ["launchctl", ["bootstrap", "gui/501", plistPath]],
      ["launchctl", ["enable", `gui/501/${channelConfig.launchdLabel}`]],
      ["launchctl", ["print", `gui/501/${channelConfig.launchdLabel}`]],
    ]);
  });

  it("refreshes launchd unit files for auto-update without unloading the current label", () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 654\n", stderr: "" });

    const info = refreshClientServiceUnitForUpdate();
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);

    expect(info).toMatchObject({
      platform: "launchd",
      label: channelConfig.launchdLabel,
      state: "active",
      pid: 654,
      unitPath: plistPath,
    });
    expect(readFileSync(wrapperPath, "utf-8")).toContain(
      `exec ${process.execPath} ${process.argv[1]} daemon start --no-interactive`,
    );
    expect(readFileSync(plistPath, "utf-8")).toContain(`<string>${wrapperPath}</string>`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["launchctl", ["print", `gui/501/${channelConfig.launchdLabel}`]],
    ]);
  });

  it("detects launchd unit drift and reports unsupported refresh/drift platforms", () => {
    setPlatform("darwin");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(isServiceUnitDriftDetected()).toBe(true);

    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(wrapperPath), { recursive: true });
    mkdirSync(dirname(plistPath), { recursive: true });
    const invocation = { kind: "node" as const, program: process.execPath, args: [process.argv[1] ?? ""] };
    writeFileSync(wrapperPath, renderLaunchdWrapper(invocation));
    writeFileSync(plistPath, renderPlist(wrapperPath));
    expect(isServiceUnitDriftDetected()).toBe(false);

    setPlatform("win32");
    expect(isServiceUnitDriftDetected()).toBe(false);
    expect(() => refreshClientServiceUnitForUpdate()).toThrow("Background service refresh is not supported on win32");
  });

  it("surfaces launchd bootstrap retry failures and warnings", () => {
    setPlatform("darwin");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(10_001);
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootout failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed once" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed twice" });

    expect(() => installClientService()).toThrow("launchctl bootstrap failed: bootstrap failed twice");
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl bootout"));
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("bootout still settling"));
    dateNowSpy.mockRestore();

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed once" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "enable failed" })
      .mockReturnValueOnce({ status: 0, stdout: "state = stopped\n", stderr: "" });
    expect(installClientService()).toMatchObject({ platform: "launchd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl enable: enable failed"));
  });

  it("reports launchd uninstall and stop warnings", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootout exploded" });
    expect(uninstallClientService()).toMatchObject({ state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: bootout during uninstall"));

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "stop failed" });
    expect(stopClientService()).toEqual({ ok: false, reason: "stop failed" });

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "kick failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed" });
    writeFileSync(plistPath, "plist");
    expect(restartClientService()).toEqual({ ok: false, reason: "bootstrap failed" });
  });

  it("stops launchd services successfully", () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    expect(stopClientService()).toEqual({ ok: true });
  });

  it("uninstalls launchd files even when bootout reports the label is absent", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(dirname(wrapperPath), { recursive: true });
    writeFileSync(plistPath, "plist");
    writeFileSync(wrapperPath, "wrapper");
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" });

    expect(uninstallClientService()).toMatchObject({
      platform: "launchd",
      label: channelConfig.launchdLabel,
      state: "not-installed",
      unitPath: plistPath,
    });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(wrapperPath)).toBe(false);
  });

  it("returns unsupported status for uninstall and throws install errors on unsupported platforms", () => {
    setPlatform("win32");
    expect(() => installClientService()).toThrow("Background service install is not supported on win32");
    expect(uninstallClientService()).toMatchObject({
      platform: "unsupported",
      label: "",
      state: "not-installed",
      detail: "platform win32 not supported",
    });
  });
});
