import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  applyClientLoggerConfig: vi.fn(),
  configureClientLoggerForService: vi.fn(),
  discoverClaudeCodeSkills: vi.fn(),
  probeCapabilities: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  ClientRuntime: vi.fn(),
  createApiNameResolver: vi.fn(),
  createExecuteUpdate: vi.fn(),
  declineUpdate: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  getClientServiceStatus: vi.fn(),
  handleClientOrgMismatch: vi.fn(),
  isServiceSupported: vi.fn(),
  loadCredentials: vi.fn(),
  migrateLocalAgentDirs: vi.fn(),
  promptMissingFields: vi.fn(),
  promptUpdate: vi.fn(),
  reconcileLocalRuntimeProviders: vi.fn(),
  startClientService: vi.fn(),
  uploadAgentSkills: vi.fn(),
  uploadClientCapabilities: vi.fn(),
}));

const failMock = vi.hoisted(() =>
  vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
);

vi.mock("@first-tree/client", () => ({
  ...clientMocks,
  ClientOrgMismatchError: class ClientOrgMismatchError extends Error {},
  ClientUserMismatchError: class ClientUserMismatchError extends Error {},
}));

vi.mock("../core/index.js", () => ({
  ...coreMocks,
  COMMAND_VERSION: "0.0.0-test",
}));

vi.mock("../cli/output.js", () => ({
  fail: failMock,
}));

const originalHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalServiceMode = process.env.FIRST_TREE_SERVICE_MODE;
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
  throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
});

let home: string;
let runtimeInstance: {
  addAgent: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  watchAgentsDir: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ft-daemon-start-"));
  mkdirSync(join(home, "config", "agents", "kael"), { recursive: true });
  writeFileSync(
    join(home, "config", "client.yaml"),
    "server:\n  url: https://first-tree.example\nclient:\n  id: client_1234abcd\n",
  );
  writeFileSync(join(home, "config", "agents", "kael", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  delete process.env.FIRST_TREE_SERVICE_MODE;

  for (const mock of Object.values(clientMocks)) mock.mockReset();
  for (const mock of Object.values(coreMocks)) mock.mockReset();
  failMock.mockClear();
  stderrSpy.mockClear();

  clientMocks.probeCapabilities.mockResolvedValue({ "claude-code": { state: "ok" } });
  clientMocks.discoverClaudeCodeSkills.mockResolvedValue([{ name: "review", description: "Review code." }]);
  coreMocks.loadCredentials.mockReturnValue({ refreshToken: "refresh" });
  coreMocks.isServiceSupported.mockReturnValue(false);
  coreMocks.getClientServiceStatus.mockReturnValue({
    platform: "launchd",
    state: "not-installed",
    label: "dev.first-tree",
    logDir: join(home, "logs"),
  });
  coreMocks.startClientService.mockReturnValue({ ok: true });
  coreMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  coreMocks.promptMissingFields.mockResolvedValue(undefined);
  coreMocks.createApiNameResolver.mockReturnValue(async () => "kael");
  coreMocks.createExecuteUpdate.mockReturnValue(async () => undefined);
  coreMocks.migrateLocalAgentDirs.mockResolvedValue(undefined);
  coreMocks.reconcileLocalRuntimeProviders.mockResolvedValue(undefined);
  coreMocks.uploadClientCapabilities.mockResolvedValue(undefined);
  coreMocks.uploadAgentSkills.mockResolvedValue(undefined);

  runtimeInstance = {
    addAgent: vi.fn(),
    start: vi.fn(async () => undefined),
    watchAgentsDir: vi.fn(() => {
      throw new Error("stop after watch");
    }),
  };
  coreMocks.ClientRuntime.mockImplementation(() => runtimeInstance);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  if (originalServiceMode === undefined) delete process.env.FIRST_TREE_SERVICE_MODE;
  else process.env.FIRST_TREE_SERVICE_MODE = originalServiceMode;
});

async function runStart(args: string[] = []): Promise<unknown> {
  const { resetConfig, resetConfigMeta } = await import("@first-tree/shared/config");
  resetConfig();
  resetConfigMeta();
  const { registerDaemonStartCommand } = await import("../commands/daemon/start.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const daemon = program.command("daemon");
  registerDaemonStartCommand(daemon);
  return program.parseAsync(["node", "test", "daemon", "start", ...args]);
}

function output(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
}

describe("daemon start command", () => {
  it("fails closed when credentials are missing", async () => {
    coreMocks.loadCredentials.mockReturnValueOnce(null);

    await expect(runStart()).rejects.toMatchObject({ code: "NO_CREDENTIALS", exitCode: 1 });
    expect(failMock).toHaveBeenCalledWith("NO_CREDENTIALS", expect.stringContaining("no credentials"), 1);
  });

  it("refuses when the background service is already active", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "active",
      label: "first-tree.service",
      detail: "pid 123",
      logDir: "/logs",
    });

    await expect(runStart()).resolves.toBeTruthy();
    expect(output()).toContain("Service is already running");
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
  });

  it("starts an inactive service and prints log hints", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({ platform: "systemd", state: "inactive", label: "first-tree.service", logDir: "/logs" })
      .mockReturnValueOnce({
        platform: "systemd",
        state: "active",
        label: "first-tree.service",
        detail: "pid 123",
        logDir: "/logs",
      });

    await expect(runStart()).resolves.toBeTruthy();
    expect(coreMocks.startClientService).toHaveBeenCalled();
    expect(output()).toContain("Started systemd service");
    expect(output()).toContain("journalctl --user -u first-tree");
  });

  it("prints WSL repair guidance when service startup fails", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "inactive",
      label: "first-tree.service",
      logDir: "/logs",
    });
    coreMocks.startClientService.mockReturnValueOnce({
      ok: false,
      reason: "Failed to connect to bus: No such file or directory",
    });

    await expect(runStart()).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("Failed to start service");
    expect(output()).toContain("Try `--foreground` to run inline instead.");
  });

  it("refuses unknown service state", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "launchd",
      state: "unknown",
      label: "dev.first-tree",
      detail: "confused",
      logDir: "/logs",
    });

    await expect(runStart()).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("Service state could not be determined");
  });

  it("runs inline, reconciles local state, uploads capabilities and skills", async () => {
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.promptMissingFields).toHaveBeenCalledWith(expect.objectContaining({ noInteractive: false }));
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "info" });
    expect(coreMocks.migrateLocalAgentDirs).toHaveBeenCalled();
    expect(clientMocks.probeCapabilities).toHaveBeenCalled();
    expect(coreMocks.reconcileLocalRuntimeProviders).toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).toHaveBeenCalledWith(
      "https://first-tree.example",
      "client_1234abcd",
      expect.objectContaining({ currentVersion: "0.0.0-test" }),
    );
    expect(runtimeInstance.addAgent).toHaveBeenCalledWith("kael", expect.objectContaining({ agentId: "agent-1" }));
    expect(runtimeInstance.start).toHaveBeenCalled();
    expect(coreMocks.uploadClientCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client_1234abcd", capabilities: { "claude-code": { state: "ok" } } }),
    );
    expect(coreMocks.uploadAgentSkills).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", skills: [{ name: "review", description: "Review code." }] }),
    );
    expect(runtimeInstance.watchAgentsDir).toHaveBeenCalledWith(join(home, "config", "agents"));
    expect(output()).toContain("Error: stop after watch");
  });

  it("uses service-mode logging and non-interactive prompts for supervisor children", async () => {
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.promptMissingFields).toHaveBeenCalledWith(expect.objectContaining({ noInteractive: true }));
    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledWith(join(home, "logs"));
    expect(coreMocks.ClientRuntime).toHaveBeenCalledWith(
      "https://first-tree.example",
      "client_1234abcd",
      expect.objectContaining({
        update: expect.objectContaining({ prompt: coreMocks.declineUpdate }),
      }),
    );
  });

  it("continues when best-effort reconciliation and uploads fail", async () => {
    coreMocks.migrateLocalAgentDirs.mockRejectedValueOnce(new Error("rename failed"));
    coreMocks.reconcileLocalRuntimeProviders.mockRejectedValueOnce(new Error("runtime probe failed"));
    coreMocks.uploadClientCapabilities.mockRejectedValueOnce(new Error("capabilities failed"));
    clientMocks.discoverClaudeCodeSkills.mockRejectedValueOnce(new Error("skill scan failed"));

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    const text = output();
    expect(text).toContain("agent-dir migration skipped: rename failed");
    expect(text).toContain("runtime-provider reconcile skipped: runtime probe failed");
    expect(text).toContain("capabilities upload skipped: capabilities failed");
    expect(text).toContain("skills upload skipped: skill scan failed");
  });
});
