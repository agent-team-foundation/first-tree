import { describe, expect, it, vi } from "vitest";

type LoadedSubject = {
  runDaemonChecks: () => Promise<unknown[]>;
  mocks: {
    checkAgentConfigs: ReturnType<typeof vi.fn>;
    checkBackgroundService: ReturnType<typeof vi.fn>;
    checkClientConfig: ReturnType<typeof vi.fn>;
    checkNodeVersion: ReturnType<typeof vi.fn>;
    checkServerReachable: ReturnType<typeof vi.fn>;
    checkWebSocket: ReturnType<typeof vi.fn>;
    initConfig: ReturnType<typeof vi.fn>;
    listMyAgents: ReturnType<typeof vi.fn>;
    reconcileAgentConfigs: ReturnType<typeof vi.fn>;
    resetConfig: ReturnType<typeof vi.fn>;
    resetConfigMeta: ReturnType<typeof vi.fn>;
    resolveServerUrl: ReturnType<typeof vi.fn>;
    sdkOptions: unknown[];
  };
};

async function loadSubject(opts: { resolveServerUrlThrows?: boolean } = {}): Promise<LoadedSubject> {
  vi.resetModules();

  const sdkOptions: unknown[] = [];
  const listMyAgents = vi.fn(async () => [{ uuid: "agent-1", name: "atlas" }]);
  const initConfig = vi.fn(async () => ({ client: { id: "client-1" } }));
  const resetConfig = vi.fn();
  const resetConfigMeta = vi.fn();
  const resolveServerUrl = vi.fn(() => {
    if (opts.resolveServerUrlThrows) throw new Error("server url missing");
    return "https://hub.example.test";
  });
  const checkAgentConfigs = vi.fn(() => ({ label: "Agents", status: "warn", message: "local only" }));
  const checkBackgroundService = vi.fn(() => ({ label: "Service", status: "ok" }));
  const checkClientConfig = vi.fn(() => ({ label: "Config", status: "ok" }));
  const checkNodeVersion = vi.fn(() => ({ label: "Node", status: "ok" }));
  const checkServerReachable = vi.fn(async () => ({ label: "Server", status: "ok" }));
  const checkWebSocket = vi.fn(async () => ({ label: "WebSocket", status: "ok" }));
  const ensureFreshAccessToken = vi.fn(async () => "access-token");
  const reconcileAgentConfigs = vi.fn(async () => ({ label: "Agents", status: "ok", message: "reconciled" }));

  vi.doMock("@first-tree/client", () => ({
    FirstTreeHubSDK: class FirstTreeHubSDK {
      constructor(options: unknown) {
        sdkOptions.push(options);
      }

      listMyAgents = listMyAgents;
    },
  }));
  vi.doMock("@first-tree/shared/config", () => ({
    clientConfigSchema: { test: true },
    initConfig,
    resetConfig,
    resetConfigMeta,
  }));
  vi.doMock("../core/index.js", () => ({
    CLI_USER_AGENT: "first-tree-test",
    checkAgentConfigs,
    checkBackgroundService,
    checkClientConfig,
    checkNodeVersion,
    checkServerReachable,
    checkWebSocket,
    ensureFreshAccessToken,
    reconcileAgentConfigs,
    resolveServerUrl,
  }));

  const { runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");
  return {
    runDaemonChecks,
    mocks: {
      checkAgentConfigs,
      checkBackgroundService,
      checkClientConfig,
      checkNodeVersion,
      checkServerReachable,
      checkWebSocket,
      initConfig,
      listMyAgents,
      reconcileAgentConfigs,
      resetConfig,
      resetConfigMeta,
      resolveServerUrl,
      sdkOptions,
    },
  };
}

describe("runDaemonChecks", () => {
  it("reconciles local aliases with pinned server agents when config is available", async () => {
    const { runDaemonChecks, mocks } = await loadSubject();

    const result = await runDaemonChecks();

    expect(result.map((item) => (item as { label: string }).label)).toEqual([
      "Node",
      "Config",
      "Server",
      "Agents",
      "WebSocket",
      "Service",
    ]);
    expect(mocks.resolveServerUrl).toHaveBeenCalledTimes(1);
    expect(mocks.initConfig).toHaveBeenCalledWith({ schema: { test: true }, role: "client" });
    expect(mocks.reconcileAgentConfigs).toHaveBeenCalledWith({
      clientId: "client-1",
      listPinnedAgents: expect.any(Function),
    });
    const reconcileArg = mocks.reconcileAgentConfigs.mock.calls[0]?.[0] as { listPinnedAgents: () => Promise<unknown> };
    await expect(reconcileArg.listPinnedAgents()).resolves.toEqual([{ uuid: "agent-1", name: "atlas" }]);
    expect(mocks.listMyAgents).toHaveBeenCalledTimes(1);
    expect(mocks.checkAgentConfigs).not.toHaveBeenCalled();
    expect(mocks.sdkOptions[0]).toMatchObject({
      serverUrl: "https://hub.example.test",
      userAgent: "first-tree-test",
    });
    expect(mocks.resetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resetConfigMeta).toHaveBeenCalledTimes(1);
  });

  it("falls back to local agent config checks when server config cannot be resolved", async () => {
    const { runDaemonChecks, mocks } = await loadSubject({ resolveServerUrlThrows: true });

    const result = await runDaemonChecks();

    expect(result[3]).toEqual({ label: "Agents", status: "warn", message: "local only" });
    expect(mocks.initConfig).not.toHaveBeenCalled();
    expect(mocks.reconcileAgentConfigs).not.toHaveBeenCalled();
    expect(mocks.checkAgentConfigs).toHaveBeenCalledTimes(1);
    expect(mocks.resetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resetConfigMeta).toHaveBeenCalledTimes(1);
  });
});
