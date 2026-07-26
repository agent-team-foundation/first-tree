import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  defaultDataDir: vi.fn(),
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

const cliFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));

const originalAgentId = process.env.FIRST_TREE_AGENT_ID;
const originalRuntimeSessionToken = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN;
const originalRuntimeSessionTokenFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

function latestRuntimeSessionTokenProvider(): () => string | undefined {
  const config = clientMocks.FirstTreeHubSDK.mock.calls.at(-1)?.[0] as { runtimeSessionToken?: unknown } | undefined;
  expect(config?.runtimeSessionToken).toEqual(expect.any(Function));
  return config?.runtimeSessionToken as () => string | undefined;
}

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
  if (originalRuntimeSessionToken === undefined) {
    delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN;
  } else {
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN = originalRuntimeSessionToken;
  }
  if (originalRuntimeSessionTokenFile === undefined) {
    delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
  } else {
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = originalRuntimeSessionTokenFile;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  restoreEnv();
  configMocks.defaultConfigDir.mockReturnValue("/tmp/first-tree-config");
  configMocks.defaultDataDir.mockReturnValue(join(tmpdir(), `first-tree-missing-data-${process.pid}-${Date.now()}`));
  configMocks.loadAgents.mockReturnValue(new Map([["nova", { agentId: "agent-1" }]]));
  configMocks.resolveConfigReadonly.mockReturnValue({ client: { id: "client-1" } });
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  clientMocks.FirstTreeHubSDK.mockImplementation((config: unknown) => ({
    config,
    listMyAgents: vi.fn(async () => []),
  }));
});

afterEach(() => {
  restoreEnv();
});

describe("local agent shared helpers", () => {
  it("resolves explicit, env, and single local agents and creates scoped SDK clients", async () => {
    const { createSdk, resolveLocalAgent } = await import("../commands/_shared/local-agent.js");

    expect(resolveLocalAgent("nova")).toEqual({ serverUrl: "https://hub.example", agentId: "agent-1" });

    process.env.FIRST_TREE_AGENT_ID = "agent-2";
    configMocks.loadAgents.mockReturnValueOnce(
      new Map([
        ["nova", { agentId: "agent-1" }],
        ["mira", { agentId: "agent-2" }],
      ]),
    );
    expect(resolveLocalAgent()).toEqual({ serverUrl: "https://hub.example", agentId: "agent-2" });

    createSdk("nova");
    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://hub.example",
        agentId: "agent-1",
        userAgent: expect.stringContaining("first-tree-cli/"),
      }),
    );
  });

  it("ignores the runtime session token value from the agent subprocess env", async () => {
    const { createSdk } = await import("../commands/_shared/local-agent.js");

    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN = "runtime-token-1";
    delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
    createSdk("nova");

    expect(latestRuntimeSessionTokenProvider()()).toBeUndefined();
  });

  it("reads the runtime session token file fresh after SDK construction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-"));
    try {
      const tokenFile = join(dir, "runtime.token");
      writeFileSync(tokenFile, "runtime-token-2\n", "utf8");
      const { createSdk } = await import("../commands/_shared/local-agent.js");

      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN = "runtime-token-1";
      process.env.FIRST_TREE_AGENT_ID = "agent-1";
      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = tokenFile;
      createSdk("nova");

      const resolveRuntimeSessionToken = latestRuntimeSessionTokenProvider();
      expect(resolveRuntimeSessionToken()).toBe("runtime-token-2");

      writeFileSync(tokenFile, "runtime-token-3\n", "utf8");
      expect(resolveRuntimeSessionToken()).toBe("runtime-token-3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the selected local agent's canonical runtime session token outside an agent subprocess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-"));
    try {
      const tokenDir = join(dir, "runtime-session-tokens");
      const tokenFile = join(tokenDir, "agent-1.token");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(tokenFile, "runtime-token-4\n", "utf8");
      configMocks.defaultDataDir.mockReturnValue(dir);
      delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
      const { createSdk } = await import("../commands/_shared/local-agent.js");

      createSdk("nova");

      expect(latestRuntimeSessionTokenProvider()()).toBe("runtime-token-4");
      writeFileSync(tokenFile, "runtime-token-5\n", "utf8");
      expect(latestRuntimeSessionTokenProvider()()).toBe("runtime-token-5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses token-less mode when the runtime session token file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-"));
    try {
      const tokenFile = join(dir, "missing.token");
      const { createSdk } = await import("../commands/_shared/local-agent.js");

      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN = "stale-runtime-token";
      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = tokenFile;

      expect(() => createSdk("nova")).not.toThrow();
      expect(outputMocks.fail).not.toHaveBeenCalled();
      expect(latestRuntimeSessionTokenProvider()()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses token-less mode when the runtime session token file is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-"));
    try {
      const tokenFile = join(dir, "runtime.token");
      writeFileSync(tokenFile, "\n", "utf8");
      const { createSdk } = await import("../commands/_shared/local-agent.js");

      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN = "stale-runtime-token";
      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = tokenFile;

      expect(() => createSdk("nova")).not.toThrow();
      expect(outputMocks.fail).not.toHaveBeenCalled();
      expect(latestRuntimeSessionTokenProvider()()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    configMocks.loadAgents.mockReturnValueOnce(new Map([["nova", { agentId: "agent-1" }]]));
    expect(() => resolveLocalAgent(undefined, { envMismatch: "Use --agent." })).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "ENV_AGENT_NOT_LOCAL",
      expect.stringContaining("Use --agent."),
      2,
    );
    process.env.FIRST_TREE_AGENT_ID = "missing";
    configMocks.loadAgents.mockReturnValueOnce(new Map([["nova", { agentId: "agent-1" }]]));
    expect(() => resolveLocalAgent()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "ENV_AGENT_NOT_LOCAL",
      expect.stringContaining("Pick one explicitly with `--agent <senderName>`."),
      2,
    );

    delete process.env.FIRST_TREE_AGENT_ID;
    configMocks.loadAgents.mockReturnValueOnce(
      new Map([
        ["nova", { agentId: "agent-1" }],
        ["mira", { agentId: "agent-2" }],
      ]),
    );
    expect(() => resolveLocalAgent(undefined, { ambiguous: "Pick one." })).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("AMBIGUOUS_AGENT", expect.stringContaining("Pick one."), 2);
    configMocks.loadAgents.mockReturnValueOnce(
      new Map([
        ["nova", { agentId: "agent-1" }],
        ["mira", { agentId: "agent-2" }],
      ]),
    );
    expect(() => resolveLocalAgent()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "AMBIGUOUS_AGENT",
      expect.stringContaining("Specify it explicitly with `--agent <senderName>`."),
      2,
    );

    configMocks.loadAgents.mockReturnValueOnce(new Map([["nova", { agentId: "agent-1" }]]));
    expect(() => resolveLocalAgent("missing")).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "UNKNOWN_AGENT",
      'Agent "missing" not found in /tmp/first-tree-config/agents',
      2,
    );

    configMocks.loadAgents.mockReturnValueOnce(new Map([["nova", { agentId: "agent-1" }]]));
    bootstrapMocks.resolveServerUrl.mockImplementationOnce(() => {
      throw new Error("missing server");
    });
    expect(() => resolveLocalAgent()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("MISSING_SERVER_URL", "missing server", 2);

    configMocks.loadAgents.mockReturnValueOnce(new Map([["nova", { agentId: "agent-1" }]]));
    bootstrapMocks.resolveServerUrl.mockImplementationOnce(() => {
      throw "missing server string";
    });
    expect(() => resolveLocalAgent()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("MISSING_SERVER_URL", "missing server string", 2);

    configMocks.resolveConfigReadonly.mockReturnValueOnce({ client: {} });
    expect(() => readClientId()).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith(
      "MISSING_CLIENT_ID",
      "No client.id found in client.yaml. Run `first-tree-dev login <code>` first.",
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

    expect(() => handleSdkError(new Error("plain error"))).toThrow();
    expect(outputMocks.fail).toHaveBeenLastCalledWith("UNKNOWN_ERROR", "plain error", 1);
  });
});
