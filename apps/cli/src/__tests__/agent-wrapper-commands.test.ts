import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addChatParticipantMock = vi.fn();
const bindFeishuBotMock = vi.fn();
const bindFeishuUserMock = vi.fn();
const cancelAttentionMock = vi.fn();
const cleanWorkspacesMock = vi.fn();
const cliFetchMock = vi.fn();
const confirmMock = vi.fn();
const createSdkMock = vi.fn();
const ensureFreshAccessTokenMock = vi.fn();
const ensureFreshAdminTokenMock = vi.fn();
const existsSyncMock = vi.fn();
const failMock = vi.fn();
const findStaleAliasesMock = vi.fn();
const formatStaleReasonMock = vi.fn();
const getCurrentMock = vi.fn();
const handleSdkErrorMock = vi.fn();
const listMyAgentsMock = vi.fn();
const mkdirSyncMock = vi.fn();
const patchConfigMock = vi.fn();
const printConfigMock = vi.fn();
const printLineMock = vi.fn();
const promptAddAgentMock = vi.fn();
const raiseAttentionMock = vi.fn();
const readClientIdMock = vi.fn();
const readFileSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const removeLocalAgentMock = vi.fn();
const resolveAgentMock = vi.fn();
const resolveAgentRecordMock = vi.fn();
const resolveLocalAgentMock = vi.fn();
const resolveServerUrlMock = vi.fn();
const sessionRegistryLoadMock = vi.fn();
const setConfigValueMock = vi.fn();
const showAttentionMock = vi.fn();
const successMock = vi.fn();

type RuntimeConfig = {
  agentId: string;
  payload: Record<string, unknown>;
  version: number;
};

function response(ok: boolean, body: unknown = {}, status = ok ? 200 : 500): Record<string, unknown> {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function runtimeConfig(): RuntimeConfig {
  return {
    agentId: "agent-1",
    version: 7,
    payload: {
      env: [{ key: "OLD", value: "1", sensitive: false }],
      gitRepos: [{ url: "https://github.com/example/old", ref: "main" }],
      mcpServers: [{ name: "old", transport: "stdio", command: "node" }],
      model: "old-model",
      prompt: { append: "old prompt" },
    },
  };
}

function setupMocks(): void {
  vi.doMock("node:fs", () => ({
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    readFileSync: readFileSyncMock,
    readdirSync: readdirSyncMock,
  }));
  vi.doMock("@first-tree/client", () => ({
    FirstTreeHubSDK: class FirstTreeHubSDK {
      listMyAgents = listMyAgentsMock;
    },
    SessionRegistry: class SessionRegistry {
      load(): unknown {
        return sessionRegistryLoadMock();
      }
    },
    cleanWorkspaces: cleanWorkspacesMock,
  }));
  vi.doMock("@first-tree/shared", () => ({
    attentionMetadataSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
  }));
  vi.doMock("@first-tree/shared/config", () => ({
    defaultConfigDir: () => "/tmp/first-tree-config",
    defaultDataDir: () => "/tmp/first-tree-data",
    setConfigValue: setConfigValueMock,
  }));
  vi.doMock("@inquirer/prompts", () => ({ confirm: confirmMock }));
  vi.doMock("../cli/output.js", () => ({ fail: failMock, success: successMock }));
  vi.doMock("../core/bootstrap.js", () => ({
    ensureFreshAccessToken: ensureFreshAccessTokenMock,
    ensureFreshAdminToken: ensureFreshAdminTokenMock,
    resolveServerUrl: resolveServerUrlMock,
  }));
  vi.doMock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
  vi.doMock("../core/feishu.js", () => ({
    bindFeishuBot: bindFeishuBotMock,
    bindFeishuUser: bindFeishuUserMock,
  }));
  vi.doMock("../core/index.js", () => ({
    CLI_USER_AGENT: "first-tree-test",
    ensureFreshAccessToken: ensureFreshAccessTokenMock,
    findStaleAliases: findStaleAliasesMock,
    formatStaleReason: formatStaleReasonMock,
    promptAddAgent: promptAddAgentMock,
    removeLocalAgent: removeLocalAgentMock,
    resolveServerUrl: resolveServerUrlMock,
  }));
  vi.doMock("../core/output.js", () => ({ print: { line: printLineMock } }));
  vi.doMock("../commands/_shared/local-agent.js", () => ({
    createSdk: createSdkMock,
    handleSdkError: handleSdkErrorMock,
    readClientId: readClientIdMock,
    resolveLocalAgent: resolveLocalAgentMock,
  }));
  vi.doMock("../commands/_shared/resolve-agent.js", () => ({ resolveAgent: resolveAgentMock }));
  vi.doMock("../commands/agent/config/_shared/fetchers.js", () => ({
    adminFetch: cliFetchMock,
    getCurrent: getCurrentMock,
    patchConfig: patchConfigMock,
    printConfig: printConfigMock,
    resolveAgentRecord: resolveAgentRecordMock,
  }));
  vi.doMock("../core/attention/index.js", () => ({
    cancelAttention: cancelAttentionMock,
    raiseAttention: raiseAttentionMock,
    showAttention: showAttentionMock,
  }));
}

async function loadAgentProgram(): Promise<Command> {
  setupMocks();
  const { registerAgentAddCommand } = await import("../commands/agent/add.js");
  const { registerAgentClaimCommand } = await import("../commands/agent/claim.js");
  const { registerAgentPruneCommand } = await import("../commands/agent/prune.js");
  const { registerAgentRemoveCommand } = await import("../commands/agent/remove.js");
  const { registerAgentResetCommand } = await import("../commands/agent/reset.js");
  const program = new Command();
  program.exitOverride();
  registerAgentAddCommand(program);
  registerAgentRemoveCommand(program);
  registerAgentClaimCommand(program);
  registerAgentResetCommand(program);
  registerAgentPruneCommand(program);
  return program;
}

async function loadBindProgram(): Promise<Command> {
  setupMocks();
  const { registerAgentBindBotCommand } = await import("../commands/agent/bind/bot.js");
  const { registerAgentBindClientCommand } = await import("../commands/agent/bind/client.js");
  const { registerAgentBindUserCommand } = await import("../commands/agent/bind/user.js");
  const program = new Command();
  program.exitOverride();
  registerAgentBindBotCommand(program);
  registerAgentBindClientCommand(program);
  registerAgentBindUserCommand(program);
  return program;
}

async function loadConfigProgram(): Promise<Command> {
  setupMocks();
  const { registerAgentConfigAddMcpCommand } = await import("../commands/agent/config/add-mcp.js");
  const { registerAgentConfigAddRepoCommand } = await import("../commands/agent/config/add-repo.js");
  const { registerAgentConfigAppendPromptCommand } = await import("../commands/agent/config/append-prompt.js");
  const { registerAgentConfigDryRunCommand } = await import("../commands/agent/config/dry-run.js");
  const { registerAgentConfigSetEnvCommand } = await import("../commands/agent/config/set-env.js");
  const { registerAgentConfigSetModelCommand } = await import("../commands/agent/config/set-model.js");
  const { registerAgentConfigShowCommand } = await import("../commands/agent/config/show.js");
  const program = new Command();
  program.exitOverride();
  registerAgentConfigShowCommand(program);
  registerAgentConfigSetModelCommand(program);
  registerAgentConfigAppendPromptCommand(program);
  registerAgentConfigAddMcpCommand(program);
  registerAgentConfigSetEnvCommand(program);
  registerAgentConfigAddRepoCommand(program);
  registerAgentConfigDryRunCommand(program);
  return program;
}

async function loadSessionWorkspaceProgram(): Promise<Command> {
  setupMocks();
  const { registerAgentSessionCommands } = await import("../commands/agent/session/index.js");
  const { registerAgentWorkspaceCommands } = await import("../commands/agent/workspace/index.js");
  const program = new Command();
  program.exitOverride();
  registerAgentSessionCommands(program);
  registerAgentWorkspaceCommands(program);
  return program;
}

async function loadAttentionProgram(): Promise<Command> {
  setupMocks();
  const { registerAttentionCancelCommand } = await import("../commands/attention/cancel.js");
  const { registerAttentionRaiseCommand } = await import("../commands/attention/raise.js");
  const { registerAttentionShowCommand } = await import("../commands/attention/show.js");
  const program = new Command();
  program.exitOverride();
  registerAttentionCancelCommand(program);
  registerAttentionShowCommand(program);
  registerAttentionRaiseCommand(program);
  return program;
}

describe("agent wrapper commands", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    addChatParticipantMock.mockResolvedValue([]);
    bindFeishuBotMock.mockResolvedValue(undefined);
    bindFeishuUserMock.mockResolvedValue(undefined);
    cancelAttentionMock.mockResolvedValue({ id: "attn-1", state: "cancelled" });
    cleanWorkspacesMock.mockReturnValue(["old-chat"]);
    cliFetchMock.mockResolvedValue(response(true, { memberId: "member-1" }));
    confirmMock.mockResolvedValue(true);
    createSdkMock.mockReturnValue({ addChatParticipant: addChatParticipantMock });
    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    ensureFreshAdminTokenMock.mockResolvedValue("admin-token");
    existsSyncMock.mockReturnValue(true);
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    findStaleAliasesMock.mockResolvedValue([{ agentId: "agent-old", name: "old", reason: "unpinned" }]);
    formatStaleReasonMock.mockImplementation((reason: string) => reason);
    getCurrentMock.mockResolvedValue(runtimeConfig());
    handleSdkErrorMock.mockImplementation((error: unknown) => {
      throw error;
    });
    listMyAgentsMock.mockResolvedValue([]);
    patchConfigMock.mockImplementation(
      async (_serverUrl: string, _token: string, uuid: string, version: number, patch: Record<string, unknown>) => ({
        ...runtimeConfig(),
        agentId: uuid,
        payload: { ...runtimeConfig().payload, ...patch },
        version: version + 1,
      }),
    );
    promptAddAgentMock.mockResolvedValue({ agentId: "agent-1", name: "atlas" });
    raiseAttentionMock.mockResolvedValue({ id: "attn-1", state: "open" });
    readClientIdMock.mockReturnValue("client-1");
    readFileSyncMock.mockImplementation((path: string) =>
      path.endsWith(".json") ? '{"model":"gpt-5"}' : "Prompt text",
    );
    readdirSyncMock.mockReturnValue(["atlas"]);
    resolveAgentMock.mockResolvedValue({ name: "atlas", uuid: "agent-1" });
    resolveAgentRecordMock.mockResolvedValue({ name: "atlas", uuid: "agent-1" });
    resolveLocalAgentMock.mockReturnValue({ agentId: "agent-owner", name: "owner" });
    resolveServerUrlMock.mockReturnValue("https://hub.example.test");
    sessionRegistryLoadMock.mockReturnValue(
      new Map([
        ["active-chat", { status: "running" }],
        ["old-chat", { status: "evicted" }],
      ]),
    );
    showAttentionMock.mockResolvedValue({ id: "attn-1", state: "open" });
  });

  it("adds, removes, claims, resets, and prunes local agent state", async () => {
    const program = await loadAgentProgram();
    cliFetchMock
      .mockResolvedValueOnce(response(true, { memberId: "member-1" }))
      .mockResolvedValueOnce(response(true, { ok: true }))
      .mockResolvedValueOnce(response(true, { ok: true }));

    await program.parseAsync(["add", "--agent-id", "agent-1"], { from: "user" });
    await program.parseAsync(["remove", "atlas"], { from: "user" });
    await program.parseAsync(["claim", "atlas", "--server", "https://hub.example.test"], { from: "user" });
    await program.parseAsync(["reset", "atlas"], { from: "user" });
    await program.parseAsync(["prune", "--yes"], { from: "user" });

    expect(mkdirSyncMock).toHaveBeenCalledWith("/tmp/first-tree-config/agents/atlas", {
      mode: 448,
      recursive: true,
    });
    expect(setConfigValueMock).toHaveBeenCalledWith(
      "/tmp/first-tree-config/agents/atlas/agent.yaml",
      "agentId",
      "agent-1",
    );
    expect(removeLocalAgentMock).toHaveBeenCalledWith("atlas");
    expect(resolveAgentMock).toHaveBeenCalledWith("https://hub.example.test", "access-token", "atlas");
    expect(cleanWorkspacesMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("")).toContain('Agent "atlas" reset to idle');
  });

  it("runs bind bot, user, and client command success paths", async () => {
    const program = await loadBindProgram();
    cliFetchMock.mockResolvedValue(response(true, { ok: true }));

    await program.parseAsync(
      ["bot", "--platform", "feishu", "--app-id", "app-1", "--app-secret", "secret", "--agent", "owner"],
      { from: "user" },
    );
    await program.parseAsync(["user", "human-1", "--platform", "feishu", "--feishu-id", "ou_123"], {
      from: "user",
    });
    await program.parseAsync(["client", "atlas", "--client-id", "client-1"], { from: "user" });

    expect(bindFeishuBotMock).toHaveBeenCalledWith(
      "https://hub.example.test",
      "access-token",
      "agent-owner",
      "app-1",
      "secret",
    );
    expect(bindFeishuUserMock).toHaveBeenCalledWith(
      "https://hub.example.test",
      "access-token",
      "agent-owner",
      "human-1",
      "ou_123",
    );
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agents/agent-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(successMock).toHaveBeenCalledWith({ agentId: "agent-1", clientId: "client-1" });
  });

  it("patches runtime config through each agent config command", async () => {
    const program = await loadConfigProgram();
    cliFetchMock.mockResolvedValue({
      diff: [
        { op: "replace", path: "/model" },
        { op: "add", path: "/env/0" },
      ],
    });

    await program.parseAsync(["show", "atlas"], { from: "user" });
    await program.parseAsync(["set-model", "atlas", "gpt-5"], { from: "user" });
    await program.parseAsync(["set-env", "atlas", "DEBUG=1", "--sensitive"], { from: "user" });
    await program.parseAsync(
      ["add-repo", "atlas", "https://github.com/example/repo", "--ref", "main", "--path", "repo"],
      {
        from: "user",
      },
    );
    await program.parseAsync(["add-mcp", "atlas", "--name", "playwright", "--transport", "stdio", "--command", "npx"], {
      from: "user",
    });
    await program.parseAsync(
      ["add-mcp", "atlas", "--name", "remote", "--transport", "http", "--url", "https://mcp.test"],
      {
        from: "user",
      },
    );
    await program.parseAsync(["append-prompt", "atlas", "--file", "prompt.md"], { from: "user" });
    await program.parseAsync(["dry-run", "atlas", "--file", "patch.json"], { from: "user" });

    expect(printConfigMock).toHaveBeenCalled();
    expect(patchConfigMock).toHaveBeenCalledWith(
      "https://hub.example.test",
      "admin-token",
      "agent-1",
      7,
      expect.objectContaining({ model: "gpt-5" }),
    );
    expect(patchConfigMock).toHaveBeenCalledWith(
      "https://hub.example.test",
      "admin-token",
      "agent-1",
      7,
      expect.objectContaining({ prompt: { append: "Prompt text" } }),
    );
    expect(successMock).toHaveBeenCalledWith(expect.objectContaining({ mcpServer: "remote" }));
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agents/agent-1/config/dry-run",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists and controls sessions and cleans workspaces", async () => {
    const program = await loadSessionWorkspaceProgram();
    cliFetchMock
      .mockResolvedValueOnce(
        response(true, [
          {
            chatId: "chat-1",
            lastActivityAt: "2026-05-28T00:00:00.000Z",
            runtimeState: "running",
            state: "active",
          },
        ]),
      )
      .mockResolvedValueOnce(response(true, { ok: true }))
      .mockResolvedValueOnce(response(true, { ok: true }));

    await program.parseAsync(["session", "list", "atlas", "--state", "active"], { from: "user" });
    await program.parseAsync(["session", "suspend", "atlas", "chat-1"], { from: "user" });
    await program.parseAsync(["session", "terminate", "atlas", "chat-1"], { from: "user" });
    await program.parseAsync(["workspace", "clean", "atlas", "--ttl", "1"], { from: "user" });

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agents/agent-1/sessions?state=active",
      expect.objectContaining({ headers: { Authorization: "Bearer access-token" } }),
    );
    expect(cleanWorkspacesMock).toHaveBeenCalledWith(
      "/tmp/first-tree-data/workspaces/atlas",
      new Set(["active-chat"]),
      86_400_000,
    );
    expect(printLineMock.mock.calls.flat().join("")).toContain("1 workspace(s) cleaned");
  });

  it("raises, shows, and cancels attention records", async () => {
    const program = await loadAttentionProgram();

    await program.parseAsync(["raise", "--chat", "chat-1", "--target", "ada", "--subject", "Ship?", "--body", "LGTM"], {
      from: "user",
    });
    await program.parseAsync(["show", "attn-1", "--agent", "atlas"], { from: "user" });
    await program.parseAsync(["cancel", "attn-1", "--reason", "Done"], { from: "user" });

    expect(raiseAttentionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: "LGTM", chatId: "chat-1", target: "ada" }),
    );
    expect(showAttentionMock).toHaveBeenCalledWith(expect.anything(), "attn-1");
    expect(cancelAttentionMock).toHaveBeenCalledWith(expect.anything(), { id: "attn-1", reason: "Done" });
    expect(successMock).toHaveBeenCalledWith(expect.objectContaining({ id: "attn-1" }));
  });
});
