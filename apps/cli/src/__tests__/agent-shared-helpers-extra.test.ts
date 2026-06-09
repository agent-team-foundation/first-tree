import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => {
  class SdkError extends Error {
    constructor(
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = "SdkError";
    }
  }

  return {
    FirstTreeHubSDK: vi.fn(),
    SdkError,
  };
});

const configMocks = vi.hoisted(() => ({
  agentConfigSchema: {},
  clientConfigSchema: {},
  defaultConfigDir: vi.fn(),
  loadAgents: vi.fn(),
  resolveConfigReadonly: vi.fn(),
}));

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
}));

const agentPruneMocks = vi.hoisted(() => ({
  findStaleAliases: vi.fn(),
  formatStaleReason: vi.fn((reason: unknown) => {
    if (typeof reason === "object" && reason !== null && "kind" in reason) return String(reason.kind);
    return String(reason);
  }),
  removeLocalAgent: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/agent-prune.js", () => agentPruneMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("@inquirer/prompts", () => promptMocks);
vi.mock("../core/output.js", () => ({ print: { line: printLineMock } }));

const originalAgentId = process.env.FIRST_TREE_AGENT_ID;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

function restoreEnv(): void {
  if (originalAgentId === undefined) {
    delete process.env.FIRST_TREE_AGENT_ID;
  } else {
    process.env.FIRST_TREE_AGENT_ID = originalAgentId;
  }
  if (originalServerUrl === undefined) {
    delete process.env.FIRST_TREE_SERVER_URL;
  } else {
    process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  restoreEnv();
  configMocks.defaultConfigDir.mockReturnValue("/tmp/first-tree-config");
  configMocks.loadAgents.mockReturnValue(new Map([["kael", { agentId: "agent-1" }]]));
  configMocks.resolveConfigReadonly.mockReturnValue({ client: { id: "client-1" } });
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  clientMocks.FirstTreeHubSDK.mockImplementation((config: unknown) => ({
    config,
    listMyAgents: vi.fn(async () => []),
  }));
  agentPruneMocks.findStaleAliases.mockResolvedValue([]);
  promptMocks.confirm.mockResolvedValue(true);
});

afterEach(() => {
  restoreEnv();
});

describe("local agent shared helpers", () => {
  it("resolves explicit, env, and single local agents and creates scoped SDK clients", async () => {
    const { createSdk, resolveLocalAgent } = await import("../commands/_shared/local-agent.js");

    expect(resolveLocalAgent("kael")).toEqual({ serverUrl: "https://hub.example", agentId: "agent-1" });

    process.env.FIRST_TREE_AGENT_ID = "agent-2";
    configMocks.loadAgents.mockReturnValueOnce(
      new Map([
        ["kael", { agentId: "agent-1" }],
        ["mira", { agentId: "agent-2" }],
      ]),
    );
    expect(resolveLocalAgent()).toEqual({ serverUrl: "https://hub.example", agentId: "agent-2" });

    createSdk("kael");
    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://hub.example",
        agentId: "agent-1",
        userAgent: expect.stringContaining("first-tree-cli/"),
      }),
    );
  });

  it("maps local agent resolution failures to CLI errors", async () => {
    const { readClientId, resolveLocalAgent } = await import("../commands/_shared/local-agent.js");

    configMocks.loadAgents.mockReturnValueOnce(new Map());
    expect(() => resolveLocalAgent()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "MISSING_AGENT",
      "No agent configured. Run `first-tree-dev agent add` first.",
      2,
    );

    process.env.FIRST_TREE_AGENT_ID = "missing";
    configMocks.loadAgents.mockReturnValueOnce(new Map([["kael", { agentId: "agent-1" }]]));
    expect(() => resolveLocalAgent(undefined, { envMismatch: "Use --agent." })).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "ENV_AGENT_NOT_LOCAL",
      expect.stringContaining("Use --agent."),
      2,
    );

    delete process.env.FIRST_TREE_AGENT_ID;
    configMocks.loadAgents.mockReturnValueOnce(
      new Map([
        ["kael", { agentId: "agent-1" }],
        ["mira", { agentId: "agent-2" }],
      ]),
    );
    expect(() => resolveLocalAgent(undefined, { ambiguous: "Pick one." })).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("AMBIGUOUS_AGENT", expect.stringContaining("Pick one."), 2);

    configMocks.loadAgents.mockReturnValueOnce(new Map([["kael", { agentId: "agent-1" }]]));
    bootstrapMocks.resolveServerUrl.mockImplementationOnce(() => {
      throw new Error("missing server");
    });
    expect(() => resolveLocalAgent()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("MISSING_SERVER_URL", "missing server", 2);

    configMocks.resolveConfigReadonly.mockReturnValueOnce({ client: {} });
    expect(() => readClientId()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "MISSING_CLIENT_ID",
      "No client.id found in client.yaml. Run `first-tree-dev login <token>` first.",
      2,
    );
  });

  it("maps SDK, connection, and unknown errors to CLI failures", async () => {
    const { handleSdkError } = await import("../commands/_shared/local-agent.js");

    expect(() => handleSdkError(new clientMocks.SdkError(401, "expired"))).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("HTTP_401", "expired", 3);

    expect(() => handleSdkError(new clientMocks.SdkError(500, "down"))).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("HTTP_500", "down", 1);

    expect(() => handleSdkError(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("CONNECTION_ERROR", "Cannot connect to server: fetch failed", 6);

    expect(() => handleSdkError("boom")).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("UNKNOWN_ERROR", "boom", 1);
  });
});

describe("account transfer helpers", () => {
  it("posts client claims with auth headers and surfaces server failures", async () => {
    const { postClaim } = await import("../commands/_shared/account-transfer.js");
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse({ clientId: "client-1", previousUserId: "user-old", unpinnedAgentCount: 2 }),
    );

    await expect(postClaim("https://hub.example", "client/1")).resolves.toEqual({
      clientId: "client-1",
      previousUserId: "user-old",
      unpinnedAgentCount: 2,
    });
    expect(cliFetchMock).toHaveBeenCalledWith("https://hub.example/api/v1/clients/client%2F1/claim", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: expect.any(AbortSignal),
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse("denied", false, 409));
    await expect(postClaim("https://hub.example", "client-1")).rejects.toMatchObject({
      code: "CLAIM_ERROR",
      exitCode: 1,
    });
  });

  it("cleans stale aliases after claim with non-interactive, prompt-denied, failure, empty, and catch-all paths", async () => {
    const { cleanupStaleAliasesAfterClaim } = await import("../commands/_shared/account-transfer.js");
    agentPruneMocks.findStaleAliases.mockResolvedValueOnce([
      { name: "old", agentId: "agent-old", reason: { kind: "unowned" } },
      { name: "broken", agentId: null, reason: { kind: "unreadable", error: "bad yaml" } },
    ]);
    agentPruneMocks.removeLocalAgent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("locked");
      });

    await cleanupStaleAliasesAfterClaim({
      serverUrl: "https://hub.example",
      clientId: "client-1",
      nonInteractive: true,
    });

    expect(agentPruneMocks.findStaleAliases).toHaveBeenCalledWith({
      clientId: "client-1",
      listPinnedAgents: expect.any(Function),
    });
    expect(agentPruneMocks.removeLocalAgent).toHaveBeenCalledWith("old");
    expect(agentPruneMocks.removeLocalAgent).toHaveBeenCalledWith("broken");
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("1 pruned, 1 failed");

    agentPruneMocks.findStaleAliases.mockResolvedValueOnce([
      { name: "keep", agentId: "agent-keep", reason: { kind: "pinned-elsewhere", clientId: "client-2" } },
    ]);
    promptMocks.confirm.mockResolvedValueOnce(false);
    await cleanupStaleAliasesAfterClaim({ serverUrl: "https://hub.example", clientId: "client-1" });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Skipped.");

    agentPruneMocks.findStaleAliases.mockResolvedValueOnce([]);
    await cleanupStaleAliasesAfterClaim({ serverUrl: "https://hub.example", clientId: "client-1" });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("No stale local aliases");

    agentPruneMocks.findStaleAliases.mockRejectedValueOnce(new Error("offline"));
    await cleanupStaleAliasesAfterClaim({ serverUrl: "https://hub.example", clientId: "client-1" });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Could not check for stale aliases: offline",
    );
  });
});
