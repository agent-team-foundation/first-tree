import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultConfigDirMock = vi.fn<() => string>();
const ensureFreshAccessTokenMock = vi.fn();
const failMock = vi.fn();
const loadAgentsMock = vi.fn();
const resolveConfigReadonlyMock = vi.fn();
const resolveSenderNameMock = vi.fn();
const resolveServerUrlMock = vi.fn();
const sdkConstructArgs: unknown[] = [];

class FakeSdk {
  constructor(options: unknown) {
    sdkConstructArgs.push(options);
  }
}

class FakeSdkError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function loadHelpers() {
  vi.doMock("@first-tree/client", () => ({
    FirstTreeHubSDK: FakeSdk,
    SdkError: FakeSdkError,
  }));
  vi.doMock("@first-tree/shared/config", () => ({
    agentConfigSchema: {},
    clientConfigSchema: {},
    defaultConfigDir: defaultConfigDirMock,
    loadAgents: loadAgentsMock,
    resolveConfigReadonly: resolveConfigReadonlyMock,
  }));
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
  }));
  vi.doMock("../core/agent-messaging.js", () => ({
    resolveSenderName: resolveSenderNameMock,
  }));
  vi.doMock("../core/bootstrap.js", () => ({
    ensureFreshAccessToken: ensureFreshAccessTokenMock,
    resolveServerUrl: resolveServerUrlMock,
  }));
  vi.doMock("../core/version.js", () => ({
    CLI_USER_AGENT: "first-tree-test",
  }));

  return import("../commands/_shared/local-agent.js");
}

describe("local agent CLI helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdkConstructArgs.length = 0;
    delete process.env.FIRST_TREE_AGENT_ID;
    delete process.env.FIRST_TREE_SERVER_URL;

    defaultConfigDirMock.mockReturnValue("/home/test/.first-tree/config");
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    loadAgentsMock.mockReturnValue(new Map([["atlas", { agentId: "agent-atlas" }]]));
    resolveConfigReadonlyMock.mockReturnValue({ client: { id: "client-1" } });
    resolveSenderNameMock.mockReturnValue({ kind: "ok", name: "atlas" });
    resolveServerUrlMock.mockReturnValue("https://hub.example.test");
  });

  it("resolves the configured local agent and builds an SDK client", async () => {
    const { createSdk, resolveLocalAgent } = await loadHelpers();

    expect(resolveLocalAgent("atlas")).toEqual({
      agentId: "agent-atlas",
      serverUrl: "https://hub.example.test",
    });

    const sdk = createSdk("atlas");

    expect(sdk).toBeInstanceOf(FakeSdk);
    expect(defaultConfigDirMock).toHaveBeenCalled();
    expect(resolveSenderNameMock).toHaveBeenCalledWith({
      agents: new Map([["atlas", { agentId: "agent-atlas" }]]),
      envAgentId: undefined,
      override: "atlas",
    });
    expect(sdkConstructArgs[0]).toEqual(
      expect.objectContaining({
        agentId: "agent-atlas",
        serverUrl: "https://hub.example.test",
        userAgent: "first-tree-test",
      }),
    );
  });

  it("maps missing, ambiguous, and env-mismatch agent resolution to CLI failures", async () => {
    const { resolveLocalAgent } = await loadHelpers();

    resolveSenderNameMock.mockReturnValueOnce({ kind: "none" });
    expect(() => resolveLocalAgent()).toThrow("MISSING_AGENT:No agent configured.");

    resolveSenderNameMock.mockReturnValueOnce({ kind: "ambiguous", available: ["atlas", "reviewer"] });
    expect(() => resolveLocalAgent(undefined, { ambiguous: "Use --agent." })).toThrow(
      "AMBIGUOUS_AGENT:Multiple agents are configured on this machine",
    );

    resolveSenderNameMock.mockReturnValueOnce({
      kind: "envMismatch",
      envAgentId: "agent-missing",
      available: ["atlas"],
    });
    expect(() => resolveLocalAgent(undefined, { envMismatch: "Use --sender." })).toThrow(
      'ENV_AGENT_NOT_LOCAL:FIRST_TREE_AGENT_ID="agent-missing"',
    );
  });

  it("reports unknown local config, missing server URL, SDK errors, and missing client ids", async () => {
    const { handleSdkError, readClientId, resolveLocalAgent } = await loadHelpers();

    loadAgentsMock.mockReturnValueOnce(new Map());
    expect(() => resolveLocalAgent("ghost")).toThrow('UNKNOWN_AGENT:Agent "atlas" not found');

    resolveServerUrlMock.mockImplementationOnce(() => {
      throw new Error("server URL missing");
    });
    expect(() => resolveLocalAgent("atlas")).toThrow("MISSING_SERVER_URL:server URL missing");

    expect(() => handleSdkError(new FakeSdkError(401, "expired"))).toThrow("HTTP_401:expired");
    expect(() => handleSdkError(new FakeSdkError(500, "server exploded"))).toThrow("HTTP_500:server exploded");
    expect(() => handleSdkError(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toThrow(
      "CONNECTION_ERROR:Cannot connect to server: fetch failed",
    );
    expect(() => handleSdkError(new Error("other"))).toThrow("UNKNOWN_ERROR:other");

    expect(readClientId()).toBe("client-1");
    resolveConfigReadonlyMock.mockReturnValueOnce({ client: {} });
    expect(() => readClientId()).toThrow("MISSING_CLIENT_ID:No client.id found in client.yaml.");
  });
});
