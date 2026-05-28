import { join } from "node:path";
import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleanupStaleAliasesAfterClaimMock = vi.fn<() => Promise<void>>();
const cliFetchMock = vi.fn<() => Promise<Record<string, unknown>>>();
const createApiNameResolverMock = vi.fn();
const createExecuteUpdateMock = vi.fn();
const decodeJwtPayloadMock = vi.fn<(token: string) => Record<string, unknown> | null>();
const deriveHubUrlFromTokenMock = vi.fn<(token: string) => string>();
const ensureFreshAccessTokenMock = vi.fn<() => Promise<string>>();
const failMock = vi.fn((code: string, message: string) => {
  throw new Error(`${code}:${message}`);
});
const getClientServiceStatusMock = vi.fn<() => Record<string, unknown>>();
const handleClientOrgMismatchMock = vi.fn<() => Promise<void>>();
const initConfigMock = vi.fn<() => Promise<Record<string, unknown>>>();
const installClientServiceMock = vi.fn<() => Record<string, unknown>>();
const isServiceSupportedMock = vi.fn<() => boolean>();
const loadAgentsMock = vi.fn<() => Map<string, unknown>>();
const loadCredentialsMock = vi.fn<() => Record<string, unknown> | null>();
const migrateLocalAgentDirsMock = vi.fn<() => Promise<void>>();
const postClaimMock = vi.fn<() => Promise<{ unpinnedAgentCount: number }>>();
const printLineMock = vi.fn();
const printStatusMock = vi.fn();
const resetConfigMetaMock = vi.fn();
const resetConfigMock = vi.fn();
const saveCredentialsMock = vi.fn();
const selectMock = vi.fn<() => Promise<"replace" | "cancel">>();
const setConfigValueMock = vi.fn();

const runtimeState = {
  addAgent: vi.fn(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  unwatchAgentsDir: vi.fn(),
  watchAgentsDir: vi.fn(),
};

class MockClientOrgMismatchError extends Error {}

class MockHubUrlDerivationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function runLogin(args: string[]): Promise<void> {
  const { registerLoginCommand } = await import("../commands/login.js");
  const program = new Command();
  program.exitOverride();
  registerLoginCommand(program);
  await program.parseAsync(["node", "test", ...args]);
}

describe("login command", () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    cleanupStaleAliasesAfterClaimMock.mockResolvedValue();
    cliFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "access-token", refreshToken: "refresh-token" }),
    });
    createApiNameResolverMock.mockReturnValue(() => Promise.resolve(null));
    createExecuteUpdateMock.mockReturnValue(() => Promise.resolve({ installed: false }));
    decodeJwtPayloadMock.mockImplementation((token) =>
      token === "existing-token" ? { memberId: "old-member" } : { memberId: "new-member" },
    );
    deriveHubUrlFromTokenMock.mockReturnValue("https://hub.example.test");
    ensureFreshAccessTokenMock.mockResolvedValue("fresh-token");
    getClientServiceStatusMock.mockReturnValue({ state: "inactive", detail: "stopped" });
    handleClientOrgMismatchMock.mockResolvedValue();
    initConfigMock.mockResolvedValue({
      client: { id: "client-1" },
      server: { url: "https://hub.example.test" },
      update: { policy: "manual" },
    });
    installClientServiceMock.mockReturnValue({ platform: "systemd", logDir: "/tmp/first-tree/logs" });
    isServiceSupportedMock.mockReturnValue(true);
    loadAgentsMock.mockReturnValue(new Map([["atlas", { runtime: "claude-code" }]]));
    loadCredentialsMock.mockReturnValue(null);
    migrateLocalAgentDirsMock.mockResolvedValue();
    postClaimMock.mockResolvedValue({ unpinnedAgentCount: 2 });
    selectMock.mockResolvedValue("replace");
    runtimeState.start.mockRejectedValue(new Error("runtime failed"));
    runtimeState.stop.mockResolvedValue();

    vi.doMock("@first-tree/client", () => ({ ClientOrgMismatchError: MockClientOrgMismatchError }));
    vi.doMock("@first-tree/shared/config", () => ({
      agentConfigSchema: {},
      clientConfigSchema: {},
      defaultConfigDir: () => "/tmp/first-tree/config",
      defaultDataDir: () => "/tmp/first-tree/data",
      initConfig: initConfigMock,
      loadAgents: loadAgentsMock,
      resetConfig: resetConfigMock,
      resetConfigMeta: resetConfigMetaMock,
      setConfigValue: setConfigValueMock,
    }));
    vi.doMock("@inquirer/prompts", () => ({ select: selectMock }));
    vi.doMock("../cli/output.js", () => ({ fail: failMock }));
    vi.doMock("../commands/_shared/account-transfer.js", () => ({
      cleanupStaleAliasesAfterClaim: cleanupStaleAliasesAfterClaimMock,
      postClaim: postClaimMock,
    }));
    vi.doMock("../commands/_shared/connect-token.js", () => ({
      decodeJwtPayload: decodeJwtPayloadMock,
      deriveHubUrlFromToken: deriveHubUrlFromTokenMock,
      HubUrlDerivationError: MockHubUrlDerivationError,
    }));
    vi.doMock("../core/index.js", () => ({
      ClientRuntime: class ClientRuntime {
        addAgent(name: string, config: unknown): void {
          runtimeState.addAgent(name, config);
        }
        start(): Promise<void> {
          return runtimeState.start();
        }
        stop(): Promise<void> {
          return runtimeState.stop();
        }
        unwatchAgentsDir(): void {
          runtimeState.unwatchAgentsDir();
        }
        watchAgentsDir(path: string): void {
          runtimeState.watchAgentsDir(path);
        }
      },
      COMMAND_VERSION: "0.5.2-test",
      cliFetch: cliFetchMock,
      createApiNameResolver: createApiNameResolverMock,
      createExecuteUpdate: createExecuteUpdateMock,
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
      getClientServiceStatus: getClientServiceStatusMock,
      handleClientOrgMismatch: handleClientOrgMismatchMock,
      installClientService: installClientServiceMock,
      isServiceSupported: isServiceSupportedMock,
      loadCredentials: loadCredentialsMock,
      migrateLocalAgentDirs: migrateLocalAgentDirsMock,
      promptUpdate: vi.fn(),
      saveCredentials: saveCredentialsMock,
    }));
    vi.doMock("../core/output.js", () => ({ print: { line: printLineMock, status: printStatusMock } }));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("exchanges a connect token, writes config and credentials, and honors --no-start", async () => {
    await runLogin(["login", "connect-token", "--no-start"]);

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/auth/connect-token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "connect-token" }) }),
    );
    expect(setConfigValueMock).toHaveBeenCalledWith(
      join("/tmp/first-tree/config", "client.yaml"),
      "server.url",
      "https://hub.example.test",
    );
    expect(saveCredentialsMock).toHaveBeenCalledWith({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      serverUrl: "https://hub.example.test",
    });
    expect(initConfigMock).toHaveBeenCalledWith(expect.objectContaining({ role: "client" }));
    expect(installClientServiceMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("")).toContain("daemon not launched");
    expect(resetConfigMock).toHaveBeenCalled();
    expect(resetConfigMetaMock).toHaveBeenCalled();
  });

  it("lets the operator cancel replacement of an existing different account", async () => {
    loadCredentialsMock.mockReturnValue({ accessToken: "existing-token", serverUrl: "https://old.example.test" });
    selectMock.mockResolvedValueOnce("cancel");

    await runLogin(["login", "connect-token", "--no-start"]);

    expect(getClientServiceStatusMock).toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalled();
    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("")).toContain("Existing setup untouched");
  });

  it("skips replacement prompt for the same member and installs the service by default", async () => {
    loadCredentialsMock.mockReturnValue({ accessToken: "connect-token", serverUrl: "https://hub.example.test" });

    await runLogin(["login", "connect-token"]);

    expect(selectMock).not.toHaveBeenCalled();
    expect(installClientServiceMock).toHaveBeenCalledTimes(1);
    expect(printLineMock.mock.calls.flat().join("")).toContain("Background service installed");
  });

  it("runs override ownership transfer and stale alias cleanup", async () => {
    loadCredentialsMock.mockReturnValue({ accessToken: "existing-token", serverUrl: "https://old.example.test" });

    await runLogin(["login", "connect-token", "--override"]);

    expect(selectMock).not.toHaveBeenCalled();
    expect(postClaimMock).toHaveBeenCalledWith("https://hub.example.test", "client-1");
    expect(cleanupStaleAliasesAfterClaimMock).toHaveBeenCalledWith({
      serverUrl: "https://hub.example.test",
      clientId: "client-1",
      nonInteractive: true,
    });
    expect(printLineMock.mock.calls.flat().join("")).toContain("2 agent(s) unpinned");
  });

  it("maps token derivation and exchange failures through the command error path", async () => {
    deriveHubUrlFromTokenMock.mockImplementationOnce(() => {
      throw new MockHubUrlDerivationError("BAD_TOKEN", "Token missing issuer");
    });

    await expect(runLogin(["login", "bad-token", "--no-start"])).rejects.toThrow("exit:1");
    expect(failMock).toHaveBeenCalledWith("BAD_TOKEN", "Token missing issuer", 1);

    cliFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "expired" }),
    });
    await expect(runLogin(["login", "connect-token", "--no-start"])).rejects.toThrow("exit:1");
    expect(failMock).toHaveBeenCalledWith("AUTH_ERROR", "expired", 1);
  });

  it("falls back to foreground runtime when services are unsupported and reports startup failures", async () => {
    isServiceSupportedMock.mockReturnValue(false);
    migrateLocalAgentDirsMock.mockRejectedValueOnce(new Error("cannot rename old alias"));

    await expect(runLogin(["login", "connect-token"])).rejects.toThrow("exit:1");

    expect(migrateLocalAgentDirsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentsDir: join("/tmp/first-tree/config", "agents"),
        workspacesDir: join("/tmp/first-tree/data", "workspaces"),
        sessionsDir: join("/tmp/first-tree/data", "sessions"),
      }),
    );
    expect(printStatusMock).toHaveBeenCalledWith("⚠️", expect.stringContaining("agent-dir migration skipped"));
    expect(loadAgentsMock).toHaveBeenCalled();
    expect(runtimeState.addAgent).toHaveBeenCalledWith("atlas", { runtime: "claude-code" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Background service not supported");
    expect(printLineMock.mock.calls.flat().join("")).toContain("Error: runtime failed");
  });

  it("delegates client org mismatch recovery before exiting", async () => {
    isServiceSupportedMock.mockReturnValue(false);
    runtimeState.start.mockRejectedValueOnce(new MockClientOrgMismatchError("wrong org"));

    await expect(runLogin(["login", "connect-token"])).rejects.toThrow("exit:1");

    expect(handleClientOrgMismatchMock).toHaveBeenCalledWith(
      expect.any(MockClientOrgMismatchError),
      expect.objectContaining({
        managed: false,
        configDir: "/tmp/first-tree/config",
        rerunCommand: "first-tree login <token>",
      }),
    );
  });
});
