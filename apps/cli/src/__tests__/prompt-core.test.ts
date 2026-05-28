import { beforeEach, describe, expect, it, vi } from "vitest";

type MissingPrompt = {
  dotPath: string;
  prompt: {
    type?: "input" | "password" | "select";
    message: string;
    default?: string;
    choices?: Array<{ name: string; value: string }>;
  };
};

const {
  cliFetchMock,
  collectMissingPromptsMock,
  defaultConfigDirMock,
  defaultHomeMock,
  ensureFreshAccessTokenMock,
  inputMock,
  loadCredentialsMock,
  passwordMock,
  resolveServerUrlMock,
  selectMock,
  setConfigValueMock,
} = vi.hoisted(() => ({
  cliFetchMock: vi.fn(),
  collectMissingPromptsMock: vi.fn<() => MissingPrompt[]>(),
  defaultConfigDirMock: vi.fn(() => "/tmp/first-tree-config"),
  defaultHomeMock: vi.fn(() => "/tmp/first-tree-home"),
  ensureFreshAccessTokenMock: vi.fn<() => Promise<string>>(),
  inputMock: vi.fn<() => Promise<string>>(),
  loadCredentialsMock: vi.fn<() => unknown>(),
  passwordMock: vi.fn<() => Promise<string>>(),
  resolveServerUrlMock: vi.fn<() => string>(),
  selectMock: vi.fn<() => Promise<string>>(),
  setConfigValueMock: vi.fn(),
}));

vi.mock("@first-tree/shared/config", () => ({
  collectMissingPrompts: collectMissingPromptsMock,
  defaultConfigDir: defaultConfigDirMock,
  defaultHome: defaultHomeMock,
  setConfigValue: setConfigValueMock,
}));

vi.mock("@inquirer/prompts", () => ({
  input: inputMock,
  password: passwordMock,
  select: selectMock,
}));

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: ensureFreshAccessTokenMock,
  loadCredentials: loadCredentialsMock,
  resolveServerUrl: resolveServerUrlMock,
}));

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

function setStdinTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
}

const schema = {
  server: {
    _tag: "optional",
    shape: {
      url: { _tag: "field", options: { env: "FIRST_TREE_SERVER_URL" } },
    },
  },
  runtime: {
    provider: { _tag: "field", options: { env: "FIRST_TREE_RUNTIME" } },
  },
  token: { _tag: "field", options: { env: "FIRST_TREE_TOKEN" } },
  name: { _tag: "field" },
};

describe("core prompt helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStdinTty(false);
    collectMissingPromptsMock.mockReturnValue([]);
    loadCredentialsMock.mockReturnValue({ accessToken: "stored" });
    resolveServerUrlMock.mockReturnValue("https://hub.example.test");
    ensureFreshAccessTokenMock.mockResolvedValue("fresh-token");
    inputMock.mockResolvedValue("typed-value");
    passwordMock.mockResolvedValue("secret-value");
    selectMock.mockResolvedValue("selected-value");
    cliFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ name: "atlas" }),
      status: 200,
    });
  });

  it("detects interactive mode from flags and stdin", async () => {
    const { isInteractive } = await import("../core/prompt.js");

    setStdinTty(true);
    expect(isInteractive()).toBe(true);
    expect(isInteractive(true)).toBe(false);
    setStdinTty(false);
    expect(isInteractive()).toBe(false);
  });

  it("returns no changes when config prompts are already satisfied", async () => {
    const { promptMissingFields } = await import("../core/prompt.js");

    await expect(promptMissingFields({ schema, role: "client" })).resolves.toEqual({});
    expect(setConfigValueMock).not.toHaveBeenCalled();
  });

  it("reports missing non-interactive fields with env hints", async () => {
    collectMissingPromptsMock.mockReturnValue([
      { dotPath: "server.url", prompt: { message: "Server URL" } },
      { dotPath: "runtime.provider", prompt: { message: "Runtime" } },
      { dotPath: "name", prompt: { message: "Name" } },
    ]);
    const { promptMissingFields } = await import("../core/prompt.js");

    await expect(promptMissingFields({ schema, role: "server", noInteractive: true })).rejects.toThrow(
      "FIRST_TREE_SERVER_URL",
    );
    await expect(promptMissingFields({ schema, role: "server", noInteractive: true })).rejects.toThrow(
      "/tmp/first-tree-home/server.yaml",
    );
  });

  it("prompts, writes YAML values, skips auto-generation, and returns nested results", async () => {
    setStdinTty(true);
    collectMissingPromptsMock.mockReturnValue([
      {
        dotPath: "runtime.provider",
        prompt: {
          type: "select",
          message: "Runtime",
          choices: [{ name: "Auto", value: "__auto__" }],
        },
      },
      {
        dotPath: "server.url",
        prompt: {
          type: "select",
          message: "Server URL",
          choices: [{ name: "Custom", value: "__input__" }],
        },
      },
      { dotPath: "token", prompt: { type: "password", message: "Token" } },
      { dotPath: "name", prompt: { message: "Name", default: "ada" } },
    ]);
    selectMock.mockResolvedValueOnce("__auto__").mockResolvedValueOnce("__input__");
    inputMock.mockResolvedValueOnce("https://hub.example.test").mockResolvedValueOnce("ada");
    passwordMock.mockResolvedValueOnce("secret");
    const { promptMissingFields } = await import("../core/prompt.js");

    await expect(
      promptMissingFields({ schema, role: "client", configDir: "/tmp/config", cliArgs: { verbose: true } }),
    ).resolves.toEqual({
      server: { url: "https://hub.example.test" },
      token: "secret",
      name: "ada",
    });
    expect(setConfigValueMock).toHaveBeenCalledWith(
      "/tmp/config/client.yaml",
      "server.url",
      "https://hub.example.test",
    );
    expect(setConfigValueMock).toHaveBeenCalledWith("/tmp/config/client.yaml", "token", "secret");
    expect(setConfigValueMock).toHaveBeenCalledWith("/tmp/config/client.yaml", "name", "ada");
    expect(setConfigValueMock).not.toHaveBeenCalledWith(expect.any(String), "runtime.provider", expect.anything());
  });

  it("looks up the canonical hub agent name for a supplied id", async () => {
    const { promptAddAgent } = await import("../core/prompt.js");

    await expect(promptAddAgent({ agentId: "agent-1" })).resolves.toEqual({ agentId: "agent-1", name: "atlas" });
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agents/agent-1",
      expect.objectContaining({ headers: { Authorization: "Bearer fresh-token" } }),
    );
  });

  it("prompts for an agent id and surfaces preflight and lookup failures", async () => {
    const { promptAddAgent } = await import("../core/prompt.js");

    inputMock.mockResolvedValueOnce("agent-typed");
    await expect(promptAddAgent()).resolves.toEqual({ agentId: "agent-typed", name: "atlas" });

    loadCredentialsMock.mockReturnValueOnce(null);
    await expect(promptAddAgent({ agentId: "agent-1" })).rejects.toThrow("first-tree login");

    resolveServerUrlMock.mockImplementationOnce(() => {
      throw new Error("Missing server URL.");
    });
    await expect(promptAddAgent({ agentId: "agent-1" })).rejects.toThrow("FIRST_TREE_SERVER_URL");

    cliFetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await expect(promptAddAgent({ agentId: "missing" })).rejects.toThrow("HTTP 404");

    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: null }) });
    await expect(promptAddAgent({ agentId: "tombstoned" })).rejects.toThrow("has no hub name");
  });
});
