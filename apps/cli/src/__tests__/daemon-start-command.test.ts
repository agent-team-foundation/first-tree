import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const failMock = vi.fn((code: string, message: string) => {
  throw new Error(`${code}:${message}`);
});
const printLineMock = vi.fn();
const printStatusMock = vi.fn();
const loadCredentialsMock = vi.fn<() => unknown>();
const getClientServiceStatusMock = vi.fn<() => Record<string, unknown>>();
const isServiceSupportedMock = vi.fn<() => boolean>();
const startClientServiceMock = vi.fn<() => { ok: boolean; reason?: string }>();
const promptMissingFieldsMock = vi.fn<() => Promise<void>>();
const initConfigMock = vi.fn<() => Promise<Record<string, unknown>>>();
const migrateLocalAgentDirsMock = vi.fn<() => Promise<void>>();
const ensureFreshAccessTokenMock = vi.fn<() => Promise<string>>();
const probeCapabilitiesMock = vi.fn<() => Promise<Record<string, unknown>>>();
const reconcileLocalRuntimeProvidersMock = vi.fn<() => Promise<void>>();
const uploadClientCapabilitiesMock = vi.fn<() => Promise<void>>();
const uploadAgentSkillsMock = vi.fn<() => Promise<void>>();
const discoverClaudeCodeSkillsMock = vi.fn<() => Promise<unknown[]>>();
const resetConfigMock = vi.fn();
const resetConfigMetaMock = vi.fn();
const applyClientLoggerConfigMock = vi.fn();
const configureClientLoggerForServiceMock = vi.fn();
const handleClientOrgMismatchMock = vi.fn<() => Promise<void>>();
const addAgentMock = vi.fn();
const runtimeStartMock = vi.fn<() => Promise<void>>();
const runtimeStopMock = vi.fn<() => Promise<void>>();
const unwatchAgentsDirMock = vi.fn();
const watchAgentsDirMock = vi.fn();

class MockClientUserMismatchError extends Error {}
class MockClientOrgMismatchError extends Error {}

async function runStart(args: string[] = ["start"]): Promise<void> {
  const { registerDaemonStartCommand } = await import("../commands/daemon/start.js");
  const daemon = new Command("daemon");
  daemon.exitOverride();
  registerDaemonStartCommand(daemon);
  await daemon.parseAsync(["node", "test", ...args]);
}

describe("daemon start command", () => {
  let tmp: string;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "first-tree-daemon-start-"));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    loadCredentialsMock.mockReturnValue({ accessToken: "token" });
    getClientServiceStatusMock.mockReturnValue({
      detail: "pid 42",
      label: "first-tree-dev.service",
      logDir: "/tmp/logs",
      platform: "systemd",
      state: "not-installed",
    });
    isServiceSupportedMock.mockReturnValue(true);
    startClientServiceMock.mockReturnValue({ ok: true });
    promptMissingFieldsMock.mockResolvedValue();
    initConfigMock.mockResolvedValue({
      client: { id: "client-1" },
      logLevel: "debug",
      server: { url: "https://hub.example.test" },
      update: { policy: "manual" },
    });
    migrateLocalAgentDirsMock.mockResolvedValue();
    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    probeCapabilitiesMock.mockResolvedValue({ providers: {} });
    reconcileLocalRuntimeProvidersMock.mockResolvedValue();
    uploadClientCapabilitiesMock.mockResolvedValue();
    uploadAgentSkillsMock.mockResolvedValue();
    discoverClaudeCodeSkillsMock.mockResolvedValue([{ name: "review", description: "Review code" }]);
    runtimeStartMock.mockRejectedValue(new Error("runtime failed"));

    vi.doMock("@first-tree/client", () => ({
      applyClientLoggerConfig: applyClientLoggerConfigMock,
      ClientOrgMismatchError: MockClientOrgMismatchError,
      ClientUserMismatchError: MockClientUserMismatchError,
      configureClientLoggerForService: configureClientLoggerForServiceMock,
      discoverClaudeCodeSkills: discoverClaudeCodeSkillsMock,
      probeCapabilities: probeCapabilitiesMock,
    }));
    vi.doMock("@first-tree/shared/config", () => ({
      agentConfigSchema: {},
      clientConfigSchema: {},
      defaultConfigDir: () => join(tmp, "config"),
      defaultDataDir: () => join(tmp, "data"),
      defaultHome: () => tmp,
      initConfig: initConfigMock,
      loadAgents: () =>
        new Map([
          ["atlas", { agentId: "agent-1", runtime: "claude-code" }],
          ["cody", { agentId: "agent-2", runtime: "codex" }],
        ]),
      resetConfig: resetConfigMock,
      resetConfigMeta: resetConfigMetaMock,
    }));
    vi.doMock("../cli/output.js", () => ({ fail: failMock }));
    vi.doMock("../core/index.js", () => ({
      COMMAND_VERSION: "0.5.2-test",
      ClientRuntime: class ClientRuntime {
        emitConnectionResilienceEvent(): void {}
        addAgent(name: string, config: unknown): void {
          addAgentMock(name, config);
        }
        start(): Promise<void> {
          return runtimeStartMock();
        }
        stop(): Promise<void> {
          return runtimeStopMock();
        }
        unwatchAgentsDir(): void {
          unwatchAgentsDirMock();
        }
        watchAgentsDir(agentsDir: string): void {
          watchAgentsDirMock(agentsDir);
        }
      },
      createApiNameResolver: () => () => Promise.resolve(null),
      createExecuteUpdate: () => () => Promise.resolve(),
      declineUpdate: vi.fn(),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
      getClientServiceStatus: getClientServiceStatusMock,
      handleClientOrgMismatch: handleClientOrgMismatchMock,
      isServiceSupported: isServiceSupportedMock,
      loadCredentials: loadCredentialsMock,
      migrateLocalAgentDirs: migrateLocalAgentDirsMock,
      promptMissingFields: promptMissingFieldsMock,
      promptUpdate: vi.fn(),
      reconcileLocalRuntimeProviders: reconcileLocalRuntimeProvidersMock,
      startClientService: startClientServiceMock,
      uploadAgentSkills: uploadAgentSkillsMock,
      uploadClientCapabilities: uploadClientCapabilitiesMock,
    }));
    vi.doMock("../core/output.js", () => ({
      print: { line: printLineMock, status: printStatusMock },
    }));
    vi.doMock("../commands/daemon/_shared/wsl-dbus.js", () => ({ isWslDbusOvermount: () => true }));
  });

  afterEach(() => {
    delete process.env.FIRST_TREE_SERVICE_MODE;
    exitSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses startup without credentials before touching service state", async () => {
    loadCredentialsMock.mockReturnValueOnce(null);

    await expect(runStart()).rejects.toThrow("NO_CREDENTIALS");

    expect(getClientServiceStatusMock).not.toHaveBeenCalled();
  });

  it("delegates to an already installed service when possible", async () => {
    getClientServiceStatusMock.mockReturnValueOnce({
      detail: "pid 42",
      label: "first-tree-dev.service",
      logDir: "/tmp/logs",
      platform: "systemd",
      state: "active",
    });

    await runStart();
    expect(printLineMock.mock.calls.flat().join("")).toContain("Service is already running");
    expect(initConfigMock).not.toHaveBeenCalled();

    getClientServiceStatusMock.mockReset();
    getClientServiceStatusMock
      .mockReturnValueOnce({
        label: "first-tree-dev.service",
        platform: "systemd",
        state: "inactive",
      })
      .mockReturnValueOnce({
        detail: "pid 99",
        label: "first-tree-dev.service",
        logDir: "/tmp/logs",
        platform: "systemd",
        state: "active",
      });

    await runStart();
    expect(startClientServiceMock).toHaveBeenCalledTimes(1);
    expect(printLineMock.mock.calls.flat().join("")).toContain("Started systemd service");
  });

  it("prints diagnostics for service-control failures and unknown service state", async () => {
    getClientServiceStatusMock.mockReturnValueOnce({ platform: "systemd", state: "inactive" });
    startClientServiceMock.mockReturnValueOnce({ ok: false, reason: "No such file or directory /run/user/1000/bus" });

    await expect(runStart()).rejects.toThrow("exit:1");
    expect(printLineMock.mock.calls.flat().join("")).toContain("WSL2 detected");

    getClientServiceStatusMock.mockReturnValueOnce({ detail: "bad state", platform: "launchd", state: "unknown" });
    await expect(runStart()).rejects.toThrow("exit:1");
    expect(printLineMock.mock.calls.flat().join("")).toContain("Service state could not be determined");
  });

  it("runs the foreground startup path and resets config after runtime failure", async () => {
    await expect(runStart(["start", "--foreground", "--no-interactive"])).rejects.toThrow("exit:1");

    expect(promptMissingFieldsMock).toHaveBeenCalledWith(
      expect.objectContaining({ noInteractive: true, role: "client" }),
    );
    expect(applyClientLoggerConfigMock).toHaveBeenCalledWith({ level: "debug" });
    expect(migrateLocalAgentDirsMock).toHaveBeenCalledTimes(1);
    expect(probeCapabilitiesMock).toHaveBeenCalledTimes(1);
    expect(reconcileLocalRuntimeProvidersMock).toHaveBeenCalledTimes(1);
    expect(addAgentMock).toHaveBeenCalledWith("atlas", expect.objectContaining({ runtime: "claude-code" }));
    expect(addAgentMock).toHaveBeenCalledWith("cody", expect.objectContaining({ runtime: "codex" }));
    expect(printLineMock.mock.calls.flat().join("")).toContain("Error: runtime failed");
    expect(resetConfigMock).toHaveBeenCalledTimes(1);
    expect(resetConfigMetaMock).toHaveBeenCalledTimes(1);
  });

  it("uploads post-start capabilities and Claude Code skills before watching agent config", async () => {
    runtimeStartMock.mockResolvedValueOnce();
    uploadAgentSkillsMock.mockResolvedValueOnce().mockRejectedValueOnce(new Error("codex has no skill endpoint"));
    watchAgentsDirMock.mockImplementationOnce(() => {
      throw new Error("watch failed");
    });
    process.env.FIRST_TREE_SERVICE_MODE = "1";

    await expect(runStart(["start", "--foreground", "--no-interactive"])).rejects.toThrow("exit:1");

    expect(configureClientLoggerForServiceMock).toHaveBeenCalledWith(join(tmp, "logs"));
    expect(uploadClientCapabilitiesMock).toHaveBeenCalledWith({
      serverUrl: "https://hub.example.test",
      accessToken: "access-token",
      clientId: "client-1",
      capabilities: { providers: {} },
    });
    expect(discoverClaudeCodeSkillsMock).toHaveBeenCalledWith({ warn: expect.any(Function) });
    expect(uploadAgentSkillsMock).toHaveBeenCalledWith({
      serverUrl: "https://hub.example.test",
      accessToken: "access-token",
      agentId: "agent-1",
      skills: [{ name: "review", description: "Review code" }],
    });
    expect(watchAgentsDirMock).toHaveBeenCalledWith(join(tmp, "config", "agents"));
    expect(printLineMock.mock.calls.flat().join("")).toContain("Error: watch failed");
  });
});
