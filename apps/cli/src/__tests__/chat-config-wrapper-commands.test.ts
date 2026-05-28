import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addChatParticipantMock = vi.fn();
const createSdkMock = vi.fn();
const failMock = vi.fn();
const getConfigValueMock = vi.fn();
const handleSdkErrorMock = vi.fn();
const listChatsMock = vi.fn();
const listMessagesMock = vi.fn();
const printLineMock = vi.fn();
const readConfigFileMock = vi.fn();
const setConfigValueMock = vi.fn();
const successMock = vi.fn();

async function loadChatCommands(): Promise<Command> {
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
    success: successMock,
  }));
  vi.doMock("../commands/_shared/local-agent.js", () => ({
    createSdk: createSdkMock,
    handleSdkError: handleSdkErrorMock,
  }));

  const { registerChatHistoryCommand } = await import("../commands/chat/history.js");
  const { registerChatInviteCommand } = await import("../commands/chat/invite.js");
  const { registerChatListCommand } = await import("../commands/chat/list.js");
  const program = new Command();
  program.exitOverride();
  registerChatListCommand(program);
  registerChatHistoryCommand(program);
  registerChatInviteCommand(program);
  return program;
}

async function loadConfigCommands(): Promise<Command> {
  vi.doMock("@first-tree/shared/config", () => ({
    clientConfigSchema: { server: { token: "secret" } },
    defaultConfigDir: () => "/tmp/first-tree-config",
    getConfigValue: getConfigValueMock,
    readConfigFile: readConfigFileMock,
    setConfigValue: setConfigValueMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));

  const { registerConfigGetCommand } = await import("../commands/config/get.js");
  const { registerConfigSetCommand } = await import("../commands/config/set.js");
  const { registerConfigShowCommand } = await import("../commands/config/show.js");
  const program = new Command();
  program.exitOverride();
  registerConfigGetCommand(program);
  registerConfigShowCommand(program);
  registerConfigSetCommand(program);
  return program;
}

describe("chat and config wrapper commands", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    createSdkMock.mockReturnValue({
      addChatParticipant: addChatParticipantMock,
      listChats: listChatsMock,
      listMessages: listMessagesMock,
    });
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    handleSdkErrorMock.mockImplementation((error: unknown) => {
      throw error;
    });
    addChatParticipantMock.mockResolvedValue([{ agentId: "atlas" }]);
    listChatsMock.mockResolvedValue({ items: [{ id: "chat-1" }], nextCursor: null });
    listMessagesMock.mockResolvedValue({ items: [{ id: "msg-1" }], nextCursor: null });
    getConfigValueMock.mockReturnValue(undefined);
    readConfigFileMock.mockReturnValue({});
  });

  it("lists chats and fetches chat history with pagination options", async () => {
    const program = await loadChatCommands();

    await program.parseAsync(["list", "--limit", "10", "--cursor", "cursor-1", "--agent", "sender"], {
      from: "user",
    });
    expect(createSdkMock).toHaveBeenCalledWith("sender");
    expect(listChatsMock).toHaveBeenCalledWith({ limit: 10, cursor: "cursor-1" });
    expect(successMock).toHaveBeenCalledWith({ items: [{ id: "chat-1" }], nextCursor: null });

    await program.parseAsync(["history", "chat-1", "--limit", "5", "--cursor", "cursor-2"], { from: "user" });
    expect(listMessagesMock).toHaveBeenCalledWith("chat-1", { limit: 5, cursor: "cursor-2" });
    expect(successMock).toHaveBeenCalledWith({ items: [{ id: "msg-1" }], nextCursor: null });
  });

  it("invites an agent into the current chat and rejects missing chat context", async () => {
    vi.stubEnv("FIRST_TREE_CHAT_ID", "chat-1");
    const program = await loadChatCommands();

    await program.parseAsync(["invite", "atlas", "--agent", "sender"], { from: "user" });

    expect(createSdkMock).toHaveBeenCalledWith("sender");
    expect(addChatParticipantMock).toHaveBeenCalledWith("chat-1", { agentName: "atlas" });
    expect(successMock).toHaveBeenCalledWith([{ agentId: "atlas" }]);

    vi.unstubAllEnvs();
    await expect(program.parseAsync(["invite", "atlas"], { from: "user" })).rejects.toThrow("NO_CHAT_CONTEXT");
    expect(handleSdkErrorMock).toHaveBeenCalled();
  });

  it("prints config values, whole-file config, and not-set entries", async () => {
    const program = await loadConfigCommands();

    getConfigValueMock.mockReturnValueOnce("https://hub.example.test");
    await program.parseAsync(["get", "server.url"], { from: "user" });
    expect(printLineMock).toHaveBeenCalledWith("  server.url: https://hub.example.test\n");

    getConfigValueMock.mockReturnValueOnce(undefined);
    await program.parseAsync(["show", "missing.key"], { from: "user" });
    expect(printLineMock).toHaveBeenCalledWith("  missing.key: (not set)\n");

    readConfigFileMock.mockReturnValueOnce({});
    await program.parseAsync(["show"], { from: "user" });
    expect(printLineMock).toHaveBeenCalledWith("  No config found at /tmp/first-tree-config/client.yaml\n");

    readConfigFileMock.mockReturnValueOnce({ server: { url: "https://hub.example.test" }, client: { id: "client-1" } });
    await program.parseAsync(["show", "--show-secrets"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Config: /tmp/first-tree-config/client.yaml");
  });

  it("parses config set primitives before writing client.yaml", async () => {
    const program = await loadConfigCommands();

    await program.parseAsync(["set", "feature.enabled", "true"], { from: "user" });
    await program.parseAsync(["set", "feature.count", "42"], { from: "user" });
    await program.parseAsync(["set", "feature.name", "atlas"], { from: "user" });

    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      1,
      "/tmp/first-tree-config/client.yaml",
      "feature.enabled",
      true,
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(2, "/tmp/first-tree-config/client.yaml", "feature.count", 42);
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      3,
      "/tmp/first-tree-config/client.yaml",
      "feature.name",
      "atlas",
    );
  });
});
